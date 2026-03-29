const { parse } = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');

/**
 * Import Cantaloupe "Transaction Line Item Export" CSV
 */
async function importTransactionLineItems(csvContent, companyId, filename) {
  const pool = getDb();
  const records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });

  const result = { rows_total: 0, rows_imported: 0, rows_skipped: 0, rows_error: 0, errors: [] };

  // Group by Ref Nbr to find Two-Tier surcharges
  const byRef = {};
  for (const row of records) {
    const ref = row['Ref Nbr'];
    if (!byRef[ref]) byRef[ref] = [];
    byRef[ref].push(row);
  }

  async function importSale(row, surcharge) {
    const deviceId = row['Device Serial Num'];
    const slotCode = row['Item'];
    const refNbr = row['Ref Nbr'];
    const tranDate = row['Tran Date'];
    const tranTime = row['Tran Time'];
    const linePrice = parseFloat(row['Line Item Price']) || 0;
    const tranAmount = parseFloat(row['Tran Amount']) || 0;
    const typeCode = row['Trans Type Code'];
    const maskedCard = row['Masked Card Number'] || null;
    const mdbNumber = row['Line Item MDB Number'] || null;
    const quantity = parseInt(row['Quantity']) || 1;
    const twoTier = surcharge ? parseFloat(surcharge['Line Item Price']) || 0 : 0;

    const [month, day, year] = tranDate.split('/');
    const soldAt = `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')} ${tranTime}`;
    const paymentMethod = typeCode === 'C' ? 'cash' : 'credit';

    const { rows: machineRows } = await pool.query('SELECT * FROM vending_machines WHERE cantaloupe_device_id = $1 AND company_id = $2', [deviceId, companyId]);
    if (!machineRows[0]) {
      result.rows_skipped++;
      if (!result.errors.includes(`Unknown device: ${deviceId}`)) {
        result.errors.push(`Unknown device: ${deviceId}`);
      }
      return;
    }
    const machine = machineRows[0];

    let { rows: slotRows } = await pool.query('SELECT * FROM machine_slots WHERE machine_id = $1 AND slot_code = $2', [machine.id, slotCode]);
    let slot = slotRows[0];
    if (!slot) {
      const slotId = uuidv4();
      await pool.query(
        `INSERT INTO machine_slots (id, company_id, machine_id, slot_code, row_index, col_index, capacity, current_quantity) VALUES ($1, $2, $3, $4, 0, 0, 10, 0)`,
        [slotId, companyId, machine.id, slotCode]
      );
      const { rows: newSlot } = await pool.query('SELECT * FROM machine_slots WHERE id = $1', [slotId]);
      slot = newSlot[0];
    }

    const { rows: spaRows } = await pool.query('SELECT * FROM slot_product_assignments WHERE slot_id = $1 AND is_current = true', [slot.id]);
    const productId = spaRows[0] ? spaRows[0].product_id : null;

    // Insert sale with ON CONFLICT DO NOTHING for duplicate handling
    const { rows: inserted } = await pool.query(
      `INSERT INTO vending_sales
       (id, company_id, machine_id, slot_id, product_id, cantaloupe_ref_nbr, cantaloupe_device_id,
        slot_code, quantity, line_item_price, tran_amount, two_tier_surcharge, payment_method,
        trans_type_code, masked_card, mdb_number, sold_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (cantaloupe_ref_nbr, slot_code, company_id) DO NOTHING
       RETURNING id`,
      [uuidv4(), companyId, machine.id, slot.id, productId, refNbr, deviceId,
        slotCode, quantity, linePrice, tranAmount, twoTier, paymentMethod,
        typeCode, maskedCard, mdbNumber, soldAt]
    );

    if (inserted.length === 0) {
      result.rows_skipped++;
      return;
    }

    await pool.query('UPDATE machine_slots SET current_quantity = GREATEST(0, current_quantity - $1) WHERE id = $2', [quantity, slot.id]);
    result.rows_imported++;
  }

  for (const [, rows] of Object.entries(byRef)) {
    const productRows = rows.filter(r => r['Item'] !== 'Two-Tier Pricing');
    const surchargeRow = rows.find(r => r['Item'] === 'Two-Tier Pricing');

    for (const row of productRows) {
      result.rows_total++;
      try {
        await importSale(row, surchargeRow);
      } catch (e) {
        result.rows_error++;
        result.errors.push(`Error: ${e.message}`);
      }
    }
  }

  await pool.query(
    `INSERT INTO import_log (id, company_id, import_type, filename, rows_total, rows_imported, rows_skipped, rows_error, status)
     VALUES ($1, $2, 'transaction_line_item', $3, $4, $5, $6, $7, $8)`,
    [uuidv4(), companyId, filename, result.rows_total, result.rows_imported,
      result.rows_skipped, result.rows_error, result.rows_error > 0 ? 'partial' : 'complete']
  );

  return result;
}

/**
 * Import Cantaloupe "Activity Analysis" CSV (monthly summary)
 */
async function importActivityAnalysis(csvContent, companyId, filename) {
  const pool = getDb();
  const records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
  await pool.query(
    `INSERT INTO import_log (id, company_id, import_type, filename, rows_total, rows_imported, status)
     VALUES ($1, $2, 'activity_analysis', $3, $4, $5, 'complete')`,
    [uuidv4(), companyId, filename, records.length, records.length]
  );
  return { rows_total: records.length, rows_imported: records.length, rows_skipped: 0, rows_error: 0 };
}

module.exports = { importTransactionLineItems, importActivityAnalysis };
