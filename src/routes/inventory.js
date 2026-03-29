const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Warehouse inventory
router.get('/warehouse', async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query(`
      SELECT iw.*, p.name as product_name, p.category, p.purchase_price, p.sell_price, p.sku
      FROM inventory_warehouse iw
      JOIN vending_products p ON p.id = iw.product_id
      WHERE iw.company_id = $1
      ORDER BY p.name
    `, [req.user.company_id]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.patch('/warehouse/:productId', async (req, res) => {
  try {
    const pool = getDb();
    const { quantity, reorder_threshold, location_notes } = req.body;
    const { rows: ex } = await pool.query('SELECT * FROM inventory_warehouse WHERE product_id = $1 AND company_id = $2', [req.params.productId, req.user.company_id]);
    if (!ex[0]) return res.status(404).json({ error: 'Not found' });
    const existing = ex[0];

    const newQty = quantity ?? existing.quantity;
    const delta = newQty - existing.quantity;

    await pool.query(
      `UPDATE inventory_warehouse SET quantity=$1, reorder_threshold=$2, location_notes=$3, updated_at=NOW() WHERE product_id=$4 AND company_id=$5`,
      [newQty, reorder_threshold ?? existing.reorder_threshold,
        location_notes ?? existing.location_notes, req.params.productId, req.user.company_id]
    );

    if (delta !== 0) {
      await pool.query(
        `INSERT INTO inventory_events (id, company_id, product_id, event_type, quantity_delta, from_location_type, to_location_type, notes)
         VALUES ($1, $2, $3, 'adjustment', $4, 'warehouse', 'warehouse', 'Manual warehouse adjustment')`,
        [uuidv4(), req.user.company_id, req.params.productId, delta]
      );
    }

    const { rows } = await pool.query('SELECT * FROM inventory_warehouse WHERE product_id = $1 AND company_id = $2', [req.params.productId, req.user.company_id]);
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// On-site inventory
router.get('/onsite', async (req, res) => {
  try {
    const pool = getDb();
    const { location_id } = req.query;
    let query = `
      SELECT io.*, p.name as product_name, p.category, p.purchase_price,
        l.name as location_name
      FROM inventory_onsite io
      JOIN vending_products p ON p.id = io.product_id
      JOIN vending_locations l ON l.id = io.location_id
      WHERE io.company_id = $1
    `;
    const params = [req.user.company_id];
    if (location_id) { query += ' AND io.location_id = $2'; params.push(location_id); }
    query += ' ORDER BY l.name, p.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Transfer: warehouse → onsite or warehouse/onsite → machine slot
router.post('/transfer', async (req, res) => {
  const { product_id, from_type, from_id, to_type, to_id, quantity, unit_cost, notes } = req.body;
  if (!product_id || !from_type || !to_type || !quantity) {
    return res.status(400).json({ error: 'product_id, from_type, to_type, quantity required' });
  }
  const pool = getDb();
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;
    await client.query('BEGIN');

    if (from_type === 'warehouse') {
      const { rows: whRows } = await client.query('SELECT * FROM inventory_warehouse WHERE product_id = $1 AND company_id = $2', [product_id, companyId]);
      if (!whRows[0] || whRows[0].quantity < quantity) throw new Error('Insufficient warehouse stock');
      await client.query(`UPDATE inventory_warehouse SET quantity = quantity - $1, updated_at = NOW() WHERE product_id = $2 AND company_id = $3`, [quantity, product_id, companyId]);
    } else if (from_type === 'onsite') {
      const { rows: osRows } = await client.query('SELECT * FROM inventory_onsite WHERE id = $1 AND company_id = $2', [from_id, companyId]);
      if (!osRows[0] || osRows[0].quantity < quantity) throw new Error('Insufficient on-site stock');
      await client.query(`UPDATE inventory_onsite SET quantity = quantity - $1, updated_at = NOW() WHERE id = $2`, [quantity, from_id]);
    }

    if (to_type === 'onsite') {
      const { rows: existRows } = await client.query('SELECT * FROM inventory_onsite WHERE location_id = $1 AND product_id = $2 AND company_id = $3', [to_id, product_id, companyId]);
      if (existRows[0]) {
        await client.query(`UPDATE inventory_onsite SET quantity = quantity + $1, updated_at = NOW() WHERE id = $2`, [quantity, existRows[0].id]);
      } else {
        await client.query(`INSERT INTO inventory_onsite (id, company_id, location_id, product_id, quantity) VALUES ($1, $2, $3, $4, $5)`, [uuidv4(), companyId, to_id, product_id, quantity]);
      }
    } else if (to_type === 'machine') {
      const { rows: slotRows } = await client.query('SELECT * FROM machine_slots WHERE id = $1 AND company_id = $2', [to_id, companyId]);
      if (!slotRows[0]) throw new Error('Slot not found');
      await client.query('UPDATE machine_slots SET current_quantity = current_quantity + $1 WHERE id = $2', [quantity, to_id]);
    }

    await client.query(
      `INSERT INTO inventory_events (id, company_id, product_id, event_type, quantity_delta, from_location_type, from_location_id, to_location_type, to_location_id, slot_id, unit_cost, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [uuidv4(), companyId, product_id,
        `${from_type}_to_${to_type}`, quantity,
        from_type, from_type === 'warehouse' ? null : from_id,
        to_type, to_type === 'machine' ? null : to_id,
        to_type === 'machine' ? to_id : null,
        unit_cost || null, notes || null]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /inventory/warehouse/receive — enhanced receive with cost + expiry
router.post('/warehouse/receive', async (req, res) => {
  const { product_id, quantity, unit_cost, box_quantity, box_price, expiration_date, notes, purchase_order_id } = req.body;
  if (!product_id || !quantity || quantity <= 0) {
    return res.status(400).json({ error: 'product_id and quantity are required' });
  }
  const pool = getDb();
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;
    const effectiveUnitCost = unit_cost != null
      ? Number(unit_cost)
      : (box_price != null && box_quantity > 0 ? Number(box_price) / Number(box_quantity) : 0);

    await client.query('BEGIN');

    const receiptId = uuidv4();
    await client.query(
      `INSERT INTO warehouse_receipts
       (id, company_id, product_id, received_by, quantity, unit_cost, box_quantity, box_price, effective_unit_cost, expiration_date, source, purchase_order_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual', $11, $12)`,
      [receiptId, companyId, product_id, req.user.id, Number(quantity),
        unit_cost ?? null, box_quantity ?? null, box_price ?? null,
        effectiveUnitCost, expiration_date || null, purchase_order_id || null, notes || null]
    );

    const { rows: existRows } = await client.query('SELECT * FROM inventory_warehouse WHERE product_id = $1 AND company_id = $2', [product_id, companyId]);
    if (existRows[0]) {
      const existing = existRows[0];
      let newExpiry = existing.earliest_expiry;
      if (expiration_date) {
        if (!newExpiry || expiration_date < newExpiry) newExpiry = expiration_date;
      }
      await client.query(
        `UPDATE inventory_warehouse SET quantity = quantity + $1, earliest_expiry = $2, updated_at = NOW() WHERE product_id = $3 AND company_id = $4`,
        [Number(quantity), newExpiry, product_id, companyId]
      );
    } else {
      await client.query(
        `INSERT INTO inventory_warehouse (id, company_id, product_id, quantity, earliest_expiry) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), companyId, product_id, Number(quantity), expiration_date || null]
      );
    }

    await client.query(
      `INSERT INTO inventory_events (id, company_id, product_id, event_type, quantity_delta, to_location_type, unit_cost, notes)
       VALUES ($1, $2, $3, 'warehouse_receive', $4, 'warehouse', $5, $6)`,
      [uuidv4(), companyId, product_id, Number(quantity), effectiveUnitCost, notes || null]
    );

    await client.query('COMMIT');

    const { rows: receiptRows } = await pool.query('SELECT * FROM warehouse_receipts WHERE id = $1', [receiptId]);
    const { rows: warehouseRows } = await pool.query('SELECT * FROM inventory_warehouse WHERE product_id = $1 AND company_id = $2', [product_id, companyId]);
    res.json({ receipt: receiptRows[0], warehouse: warehouseRows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /inventory/expiring — products with expiry within N days
router.get('/expiring', async (req, res) => {
  try {
    const pool = getDb();
    const days = parseInt(req.query.days || '30', 10);
    const { rows } = await pool.query(`
      SELECT
        iw.product_id,
        p.name as product_name,
        p.category,
        iw.quantity,
        iw.earliest_expiry as expiration_date,
        (iw.earliest_expiry - CURRENT_DATE)::integer as days_until_expiry
      FROM inventory_warehouse iw
      JOIN vending_products p ON p.id = iw.product_id
      WHERE iw.company_id = $1
        AND iw.earliest_expiry IS NOT NULL
        AND iw.earliest_expiry <= CURRENT_DATE + ($2 * INTERVAL '1 day')
      ORDER BY iw.earliest_expiry ASC
    `, [req.user.company_id, days]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Inventory events log
router.get('/events', async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query(`
      SELECT ie.*, p.name as product_name
      FROM inventory_events ie
      JOIN vending_products p ON p.id = ie.product_id
      WHERE ie.company_id = $1
      ORDER BY ie.occurred_at DESC
      LIMIT 200
    `, [req.user.company_id]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
