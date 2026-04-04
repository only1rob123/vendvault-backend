const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

router.get('/', async (req, res) => {
  try {
    const pool = getDb();
    const { location_id } = req.query;
    let query = `
      SELECT m.*, l.name as location_name, l.city, l.state,
        COUNT(DISTINCT s.id) as slot_count,
        SUM(CASE WHEN s.current_quantity = 0 AND spa.id IS NOT NULL THEN 1 ELSE 0 END) as empty_slots,
        SUM(CASE WHEN s.current_quantity > 0 AND s.current_quantity <= (s.capacity * 0.25) THEN 1 ELSE 0 END) as low_slots
      FROM vending_machines m
      JOIN vending_locations l ON l.id = m.location_id
      LEFT JOIN machine_slots s ON s.machine_id = m.id
      LEFT JOIN slot_product_assignments spa ON spa.slot_id = s.id AND spa.is_current = true
      WHERE m.company_id = $1
    `;
    const params = [req.user.company_id];
    let i = 2;
    if (location_id) { query += ` AND m.location_id = $${i++}`; params.push(location_id); }
    query += ' GROUP BY m.id, l.name, l.city, l.state ORDER BY l.name, m.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const pool = getDb();
    const { rows: mRows } = await pool.query(`
      SELECT m.*, l.name as location_name, l.city, l.state
      FROM vending_machines m
      JOIN vending_locations l ON l.id = m.location_id
      WHERE m.id = $1 AND m.company_id = $2
    `, [req.params.id, req.user.company_id]);
    if (!mRows[0]) return res.status(404).json({ error: 'Not found' });

    const { rows: slots } = await pool.query(`
      SELECT s.*, p.name as product_name, p.category, p.image_url,
        COALESCE(spa.sell_price, p.sell_price)         as sell_price,
        COALESCE(spa.purchase_price, p.purchase_price) as purchase_price,
        spa.sell_price     as slot_sell_price,
        spa.purchase_price as slot_purchase_price,
        p.sell_price       as product_sell_price,
        p.purchase_price   as product_purchase_price,
        spa.id as assignment_id, spa.product_id, spa.assigned_at
      FROM machine_slots s
      LEFT JOIN slot_product_assignments spa ON spa.slot_id = s.id AND spa.is_current = true
      LEFT JOIN vending_products p ON p.id = spa.product_id
      WHERE s.machine_id = $1
      ORDER BY s.row_index, s.col_index
    `, [req.params.id]);

    res.json({ ...mRows[0], slots });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const { location_id, name, machine_type, cantaloupe_device_id, serial_number, model,
    layout_rows, layout_cols, commission_pct, monthly_fixed_cost } = req.body;
  if (!location_id || !name) return res.status(400).json({ error: 'location_id and name required' });
  try {
    const pool = getDb();
    const id = uuidv4();
    await pool.query(
      `INSERT INTO vending_machines (id, company_id, location_id, name, machine_type, cantaloupe_device_id, serial_number, model, layout_rows, layout_cols, commission_pct, monthly_fixed_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, req.user.company_id, location_id, name, machine_type || 'snack',
        cantaloupe_device_id || null, serial_number || null, model || null,
        layout_rows || 6, layout_cols || 10, commission_pct || 0, monthly_fixed_cost || 0]
    );
    const { rows } = await pool.query('SELECT * FROM vending_machines WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const pool = getDb();
    const { rows: ex } = await pool.query('SELECT * FROM vending_machines WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    if (!ex[0]) return res.status(404).json({ error: 'Not found' });
    const existing = ex[0];
    const { name, machine_type, cantaloupe_device_id, serial_number, model,
      layout_rows, layout_cols, commission_pct, monthly_fixed_cost, status } = req.body;
    await pool.query(
      `UPDATE vending_machines SET name=$1, machine_type=$2, cantaloupe_device_id=$3, serial_number=$4,
       model=$5, layout_rows=$6, layout_cols=$7, commission_pct=$8, monthly_fixed_cost=$9, status=$10 WHERE id=$11`,
      [name ?? existing.name, machine_type ?? existing.machine_type,
        cantaloupe_device_id ?? existing.cantaloupe_device_id, serial_number ?? existing.serial_number,
        model ?? existing.model, layout_rows ?? existing.layout_rows, layout_cols ?? existing.layout_cols,
        commission_pct ?? existing.commission_pct, monthly_fixed_cost ?? existing.monthly_fixed_cost,
        status ?? existing.status, req.params.id]
    );
    const { rows } = await pool.query('SELECT * FROM vending_machines WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST /:id/layout — save machine settings + bulk slot grid
router.post('/:id/layout', async (req, res) => {
  const pool = getDb();
  const client = await pool.connect();
  try {
    const machineId = req.params.id;
    const cid = req.user.company_id;
    const { name, machine_type, cantaloupe_device_id, serial_number, model,
      layout_rows, layout_cols, commission_pct, monthly_fixed_cost, status, cells } = req.body;

    const { rows: ex } = await client.query('SELECT * FROM vending_machines WHERE id = $1 AND company_id = $2', [machineId, cid]);
    if (!ex[0]) return res.status(404).json({ error: 'Not found' });
    const existing = ex[0];

    await client.query('BEGIN');

    await client.query(
      `UPDATE vending_machines SET name=$1, machine_type=$2, cantaloupe_device_id=$3, serial_number=$4,
       model=$5, layout_rows=$6, layout_cols=$7, commission_pct=$8, monthly_fixed_cost=$9, status=$10 WHERE id=$11`,
      [name ?? existing.name, machine_type ?? existing.machine_type,
        cantaloupe_device_id !== undefined ? (cantaloupe_device_id || null) : existing.cantaloupe_device_id,
        serial_number ?? existing.serial_number, model ?? existing.model,
        layout_rows ?? existing.layout_rows, layout_cols ?? existing.layout_cols,
        commission_pct ?? existing.commission_pct, monthly_fixed_cost ?? existing.monthly_fixed_cost,
        status ?? existing.status, machineId]
    );

    if (cells && cells.length > 0) {
      await client.query('UPDATE machine_slots SET row_index=-1, col_index=-1 WHERE machine_id=$1 AND company_id=$2', [machineId, cid]);

      for (const cell of cells) {
        if (!cell.slot_code?.trim()) continue;

        const { rows: slotRows } = await client.query(
          'SELECT * FROM machine_slots WHERE machine_id=$1 AND slot_code=$2 AND company_id=$3',
          [machineId, cell.slot_code.trim(), cid]
        );
        let slot = slotRows[0];

        if (slot) {
          await client.query('UPDATE machine_slots SET row_index=$1, col_index=$2, capacity=$3 WHERE id=$4',
            [cell.row, cell.col, cell.capacity ?? slot.capacity, slot.id]);
        } else {
          const slotId = uuidv4();
          await client.query(
            `INSERT INTO machine_slots (id, company_id, machine_id, slot_code, row_index, col_index, capacity, current_quantity) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
            [slotId, cid, machineId, cell.slot_code.trim(), cell.row, cell.col, cell.capacity ?? 10]
          );
          const { rows: newSlot } = await client.query('SELECT * FROM machine_slots WHERE id=$1', [slotId]);
          slot = newSlot[0];
        }

        if (cell.product_id !== undefined) {
          const { rows: curRows } = await client.query(
            'SELECT * FROM slot_product_assignments WHERE slot_id=$1 AND is_current=true', [slot.id]
          );
          const cur = curRows[0];
          const newPid = cell.product_id || null;
          const curPid = cur?.product_id ?? null;
          if (newPid !== curPid) {
            if (cur) {
              await client.query(`UPDATE slot_product_assignments SET is_current=false, removed_at=NOW() WHERE id=$1`, [cur.id]);
            }
            if (newPid) {
              await client.query(
                `INSERT INTO slot_product_assignments (id, company_id, slot_id, product_id, is_current) VALUES ($1, $2, $3, $4, true)`,
                [uuidv4(), cid, slot.id, newPid]
              );
            }
          }
        }
      }
    }

    await client.query('COMMIT');

    const { rows: mRows } = await pool.query(
      `SELECT m.*, l.name as location_name, l.city, l.state FROM vending_machines m JOIN vending_locations l ON l.id=m.location_id WHERE m.id=$1`,
      [machineId]
    );
    const { rows: slots } = await pool.query(`
      SELECT s.*, p.name as product_name, p.category,
        COALESCE(spa.sell_price, p.sell_price)         as sell_price,
        COALESCE(spa.purchase_price, p.purchase_price) as purchase_price,
        spa.sell_price     as slot_sell_price,
        spa.purchase_price as slot_purchase_price,
        p.sell_price       as product_sell_price,
        p.purchase_price   as product_purchase_price,
        spa.id as assignment_id, spa.product_id, spa.assigned_at
      FROM machine_slots s
      LEFT JOIN slot_product_assignments spa ON spa.slot_id=s.id AND spa.is_current=true
      LEFT JOIN vending_products p ON p.id=spa.product_id
      WHERE s.machine_id=$1 ORDER BY s.row_index, s.col_index
    `, [machineId]);
    res.json({ ...mRows[0], slots });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /:id/restock
router.post('/:id/restock', async (req, res) => {
  const pool = getDb();
  const client = await pool.connect();
  try {
    const machineId = req.params.id;
    const cid = req.user.company_id;
    const { from_type, from_id, items } = req.body;

    if (!from_type || !items?.length) {
      return res.status(400).json({ error: 'from_type and items required' });
    }

    const { rows: mRows } = await client.query('SELECT * FROM vending_machines WHERE id=$1 AND company_id=$2', [machineId, cid]);
    if (!mRows[0]) return res.status(404).json({ error: 'Not found' });

    await client.query('BEGIN');

    let totalLoaded = 0;
    for (const item of items) {
      if (!item.quantity || item.quantity <= 0) continue;
      const { rows: slotRows } = await client.query('SELECT * FROM machine_slots WHERE id=$1 AND company_id=$2', [item.slot_id, cid]);
      const slot = slotRows[0];
      if (!slot) continue;

      const { rows: spaRows } = await client.query('SELECT * FROM slot_product_assignments WHERE slot_id=$1 AND is_current=true', [slot.id]);
      const productId = spaRows[0]?.product_id || null;

      if (from_type === 'warehouse' && productId) {
        const { rows: whRows } = await client.query('SELECT * FROM inventory_warehouse WHERE product_id=$1 AND company_id=$2', [productId, cid]);
        if (whRows[0] && whRows[0].quantity >= item.quantity) {
          await client.query(`UPDATE inventory_warehouse SET quantity=quantity-$1, updated_at=NOW() WHERE product_id=$2 AND company_id=$3`, [item.quantity, productId, cid]);
        }
      } else if (from_type === 'onsite' && from_id && productId) {
        const { rows: osRows } = await client.query('SELECT * FROM inventory_onsite WHERE location_id=$1 AND product_id=$2 AND company_id=$3', [from_id, productId, cid]);
        if (osRows[0] && osRows[0].quantity >= item.quantity) {
          await client.query(`UPDATE inventory_onsite SET quantity=quantity-$1, updated_at=NOW() WHERE id=$2`, [item.quantity, osRows[0].id]);
        }
      }

      await client.query('UPDATE machine_slots SET current_quantity=LEAST(capacity, current_quantity+$1) WHERE id=$2', [item.quantity, slot.id]);

      await client.query(
        `INSERT INTO inventory_events (id, company_id, product_id, event_type, quantity_delta, from_location_type, from_location_id, to_location_type, to_location_id, slot_id, notes)
         VALUES ($1, $2, $3, 'restock', $4, $5, $6, 'machine', $7, $8, 'Machine restock')`,
        [uuidv4(), cid, productId, item.quantity,
          from_type, from_type === 'warehouse' ? null : from_id,
          machineId, slot.id]
      );

      totalLoaded += item.quantity;
    }

    await client.query('COMMIT');
    res.json({ success: true, total_loaded: totalLoaded });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
