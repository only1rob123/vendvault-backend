/**
 * Daily demo data refresh — Peak Vending Co. (demo-peak-vending-001)
 * Runs nightly via GitHub Actions.
 *
 * What it does each run:
 *  1. Generates realistic sales for yesterday (avoids today's timezone ambiguity)
 *  2. Reduces slot quantities from those sales
 *  3. Restocks any machine that has slots at or below threshold (≤2 units)
 *  4. Occasionally tops up warehouse stock when levels dip low
 */

require('dotenv').config();
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const CID = 'demo-peak-vending-001';

// ── Seeded-ish PRNG (changes daily so data varies) ────────────────────────
const todaySeed = parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
class RNG {
  constructor(s) { this.s = (s ^ 0xdeadbeef) >>> 0; }
  next()    { this.s = (Math.imul(1664525, this.s) + 1013904223) >>> 0; return this.s / 4294967296; }
  int(a, b) { return Math.floor(this.next() * (b - a + 1)) + a; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  bool(p)   { return this.next() < p; }
}
const rng = new RNG(todaySeed);

// ── Target date: yesterday (avoids timezone edge at midnight) ─────────────
function yesterday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
function isoDate(d) { return d.toISOString().slice(0, 10); }

// ── Sales velocity by machine location type ───────────────────────────────
function dailySales(locType, dow) {
  const wknd = dow === 0 || dow === 6;
  switch (locType) {
    case 'office':   return wknd ? rng.int(1, 4)   : rng.int(10, 22);
    case 'mall':     return wknd ? rng.int(20, 38)  : rng.int(9, 18);
    case 'hospital': return rng.int(16, 30);
    case 'transit':  return wknd ? rng.int(5, 12)  : rng.int(15, 28);
    case 'university': return wknd ? rng.int(4, 10) : rng.int(10, 20);
    case 'gym':      return wknd ? rng.int(10, 20)  : rng.int(6, 15);
    default:         return rng.int(8, 16);
  }
}

function saleHour(locType) {
  switch (locType) {
    case 'office':     return rng.pick([8,8,9,9,9,10,10,11,12,12,13,14,15,16,17,17]);
    case 'mall':       return rng.pick([10,11,12,12,13,14,14,15,15,16,16,17,18,19,20,20]);
    case 'hospital':   return rng.int(0, 23);
    case 'transit':    return rng.pick([7,7,7,8,8,8,9,12,13,16,16,17,17,17,18,18]);
    case 'university': return rng.pick([8,9,10,11,12,13,14,15,16,17,18,19,20,21]);
    case 'gym':        return rng.pick([6,6,7,7,8,8,9,17,17,18,18,19,20]);
    default:           return rng.int(8, 20);
  }
}

// ── Unique ref numbers: prefix with date + random suffix ─────────────────
function makeRef(dateStr, idx) {
  const ds = dateStr.replace(/-/g, '');
  return `${ds}${String(idx).padStart(6, '0')}`;
}

// ── Location type mapping ─────────────────────────────────────────────────
const LOC_TYPE = {
  'loc-riverside':  'office',
  'loc-northgate':  'mall',
  'loc-hospital':   'hospital',
  'loc-transit':    'transit',
  'loc-university': 'university',
  'loc-gym':        'gym',
};

async function main() {
  const client = await pool.connect();
  const targetDate = yesterday();
  const dateStr    = isoDate(targetDate);
  const dow        = targetDate.getUTCDay();

  console.log(`\n🌙  Daily demo refresh for ${dateStr} (DOW ${dow})\n`);

  try {
    await client.query('BEGIN');

    // ── Load machines + their slots + assigned products ─────────────────
    const { rows: machines } = await client.query(`
      SELECT vm.id, vm.location_id, vm.name, vm.cantaloupe_device_id
      FROM vending_machines vm
      WHERE vm.company_id = $1 AND vm.status = 'active'
        AND vm.installed_at <= $2::date
    `, [CID, dateStr]);

    if (!machines.length) {
      console.log('No active machines found — exiting.');
      await client.query('ROLLBACK');
      return;
    }

    let totalSales = 0;
    let totalRestocks = 0;
    let refIdx = (todaySeed % 900000) * 100; // deterministic but spread out

    for (const machine of machines) {
      const locType = LOC_TYPE[machine.location_id] || 'office';

      // Load slots with current quantities and assigned products
      const { rows: slots } = await client.query(`
        SELECT ms.id as slot_id, ms.slot_code, ms.current_quantity,
               spa.product_id, vp.sell_price, vp.purchase_price
        FROM machine_slots ms
        LEFT JOIN slot_product_assignments spa
          ON spa.slot_id = ms.id AND spa.is_current = true AND spa.company_id = $1
        LEFT JOIN vending_products vp ON vp.id = spa.product_id
        WHERE ms.machine_id = $2 AND ms.company_id = $1
      `, [CID, machine.id]);

      if (!slots.length) continue;

      // Skip if we already generated sales for this machine+date (idempotent)
      const { rows: existing } = await client.query(`
        SELECT 1 FROM vending_sales
        WHERE company_id = $1 AND machine_id = $2
          AND sold_at::date = $3::date
        LIMIT 1
      `, [CID, machine.id, dateStr]);
      if (existing.length) {
        console.log(`  ⏭  ${machine.name} — already has sales for ${dateStr}, skipping`);
        continue;
      }

      // ── Generate sales for the day ──────────────────────────────────
      const salesCount  = dailySales(locType, dow);
      const slotQty     = {};
      for (const s of slots) slotQty[s.slot_id] = s.current_quantity;

      const salesRows = [];
      for (let i = 0; i < salesCount; i++) {
        // Prefer slots that still have stock; occasionally let them empty
        const available = slots.filter(s => slotQty[s.slot_id] > 0 && s.product_id);
        if (!available.length) break;

        const slot      = rng.pick(available);
        const isCredit  = rng.bool(0.68);
        const twoTier   = isCredit && rng.bool(0.75) ? 0.10 : 0;
        const hour      = saleHour(locType);
        const soldAt    = new Date(targetDate);
        soldAt.setUTCHours(hour, rng.int(0, 59), rng.int(0, 59), 0);

        salesRows.push([
          uuidv4(), CID, machine.id, slot.slot_id, slot.product_id,
          makeRef(dateStr, ++refIdx), machine.cantaloupe_device_id, slot.slot_code,
          1, slot.sell_price, parseFloat(slot.sell_price) + twoTier, twoTier,
          isCredit ? 'credit' : 'cash',
          isCredit ? 'R' : 'C',
          isCredit ? `${rng.int(400000,699999)}******${rng.int(1000,9999)}` : null,
          null, soldAt,
        ]);

        slotQty[slot.slot_id] = Math.max(0, slotQty[slot.slot_id] - 1);
      }

      // Batch insert sales
      if (salesRows.length) {
        const cols = ['id','company_id','machine_id','slot_id','product_id',
                      'cantaloupe_ref_nbr','cantaloupe_device_id','slot_code','quantity',
                      'line_item_price','tran_amount','two_tier_surcharge','payment_method',
                      'trans_type_code','masked_card','mdb_number','sold_at'];
        const vals = salesRows.flat();
        const placeholders = salesRows.map((_, ri) =>
          `(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',')})`
        ).join(',');
        await client.query(
          `INSERT INTO vending_sales (${cols.join(',')}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
          vals
        );
        totalSales += salesRows.length;
      }

      // Update slot quantities in DB from sales
      for (const s of slots) {
        if (slotQty[s.slot_id] !== s.current_quantity) {
          await client.query(
            `UPDATE machine_slots SET current_quantity = $1 WHERE id = $2`,
            [slotQty[s.slot_id], s.slot_id]
          );
        }
      }

      console.log(`  ✅  ${machine.name} — ${salesRows.length} sales (${locType}, DOW ${dow})`);

      // ── Restock if any slot is at or below threshold ────────────────
      const lowSlots = slots.filter(s => slotQty[s.slot_id] <= 2);
      if (lowSlots.length >= Math.ceil(slots.length * 0.25)) {
        // 25%+ of slots are low → restock the whole machine
        const restockDate = new Date(targetDate);
        restockDate.setUTCHours(rng.int(6, 10), rng.int(0, 59), 0, 0);

        for (const s of slots) {
          const fill = 10 - slotQty[s.slot_id];
          if (fill <= 0 || !s.product_id) continue;

          await client.query(
            `INSERT INTO inventory_events
               (id, company_id, product_id, event_type, quantity_delta,
                from_location_type, from_location_id, to_location_type, to_location_id,
                slot_id, unit_cost, notes, occurred_at)
             VALUES ($1,$2,$3,'restock_machine',$4,'warehouse','wh-main','machine_slot',$5,$5,$6,$7,$8)`,
            [uuidv4(), CID, s.product_id, fill, s.slot_id,
             s.purchase_price, `Auto-restock: ${machine.name}`, restockDate]
          );
          await client.query(
            `UPDATE machine_slots SET current_quantity = 10 WHERE id = $1`,
            [s.slot_id]
          );
          totalRestocks++;
        }
        console.log(`  🔄  ${machine.name} restocked (${lowSlots.length} low slots)`);
      }
    }

    // ── Top up warehouse stock if any product dips below reorder threshold ──
    const { rows: lowWarehouse } = await client.query(`
      SELECT iw.id, iw.product_id, iw.quantity, iw.reorder_threshold, vp.purchase_price
      FROM inventory_warehouse iw
      JOIN vending_products vp ON vp.id = iw.product_id
      WHERE iw.company_id = $1 AND iw.quantity < iw.reorder_threshold
    `, [CID]);

    for (const row of lowWarehouse) {
      const qty      = rng.int(80, 200);
      const recvDate = new Date(targetDate);
      recvDate.setUTCHours(rng.int(8, 14), 0, 0, 0);

      await client.query(`
        INSERT INTO warehouse_receipts
          (id, company_id, product_id, quantity, unit_cost, effective_unit_cost, source, notes, received_at)
        VALUES ($1,$2,$3,$4,$5,$5,'manual','Auto top-up',$6)
      `, [uuidv4(), CID, row.product_id, qty, row.purchase_price, recvDate]);

      await client.query(`
        UPDATE inventory_warehouse SET quantity = quantity + $1 WHERE id = $2
      `, [qty, row.id]);

      await client.query(`
        INSERT INTO inventory_events
          (id, company_id, product_id, event_type, quantity_delta,
           to_location_type, to_location_id, unit_cost, notes, occurred_at)
        VALUES ($1,$2,$3,'purchase_received',$4,'warehouse','wh-main',$5,'Warehouse top-up',$6)
      `, [uuidv4(), CID, row.product_id, qty, row.purchase_price, recvDate]);
    }

    if (lowWarehouse.length) {
      console.log(`  📦  Topped up ${lowWarehouse.length} low warehouse products`);
    }

    await client.query('COMMIT');

    console.log(`\n────────────────────────────────────────`);
    console.log(`✅  Refresh complete for ${dateStr}`);
    console.log(`   Sales generated : ${totalSales}`);
    console.log(`   Slots restocked : ${totalRestocks}`);
    console.log(`   Warehouse tops  : ${lowWarehouse.length}`);
    console.log(`────────────────────────────────────────\n`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌  Refresh failed — rolled back\n', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
