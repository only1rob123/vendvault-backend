const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// GET all purchase orders
router.get('/', async (req, res) => {
  try {
    const pool = getDb();
    const { status } = req.query;
    let query = `
      SELECT pp.*, p.name as product_name, p.category, p.sku
      FROM product_purchases pp
      JOIN vending_products p ON p.id = pp.product_id
      WHERE pp.company_id = $1
    `;
    const params = [req.user.company_id];
    if (status) { query += ' AND pp.status = $2'; params.push(status); }
    query += ' ORDER BY pp.ordered_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST create new purchase order
router.post('/', async (req, res) => {
  const { product_id, quantity, unit_cost, supplier, purchase_order_ref, notes } = req.body;
  if (!product_id || !quantity || !unit_cost) {
    return res.status(400).json({ error: 'product_id, quantity, unit_cost required' });
  }
  try {
    const pool = getDb();
    const id = uuidv4();
    const total_cost = Math.round(Number(quantity) * Number(unit_cost) * 100) / 100;
    await pool.query(
      `INSERT INTO product_purchases (id, company_id, product_id, quantity, unit_cost, total_cost, supplier, purchase_order_ref, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ordered')`,
      [id, req.user.company_id, product_id, Number(quantity), Number(unit_cost), total_cost,
        supplier || null, purchase_order_ref || null, notes || null]
    );
    const { rows } = await pool.query(
      `SELECT pp.*, p.name as product_name, p.category FROM product_purchases pp JOIN vending_products p ON p.id=pp.product_id WHERE pp.id=$1`,
      [id]
    );
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// PUT /:id/receive — mark as received, add to warehouse inventory
router.put('/:id/receive', async (req, res) => {
  const pool = getDb();
  const client = await pool.connect();
  try {
    const cid = req.user.company_id;
    const { rows: poRows } = await client.query('SELECT * FROM product_purchases WHERE id=$1 AND company_id=$2', [req.params.id, cid]);
    const po = poRows[0];
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status === 'received') return res.status(400).json({ error: 'Already received' });

    const qty = Number(req.body.quantity_received ?? po.quantity);

    await client.query('BEGIN');

    await client.query(`UPDATE product_purchases SET status='received', received_at=NOW() WHERE id=$1`, [po.id]);

    const { rows: whRows } = await client.query('SELECT * FROM inventory_warehouse WHERE product_id=$1 AND company_id=$2', [po.product_id, cid]);
    if (whRows[0]) {
      await client.query(`UPDATE inventory_warehouse SET quantity=quantity+$1, updated_at=NOW() WHERE product_id=$2 AND company_id=$3`, [qty, po.product_id, cid]);
    } else {
      await client.query(`INSERT INTO inventory_warehouse (id, company_id, product_id, quantity, reorder_threshold) VALUES ($1,$2,$3,$4,10)`, [uuidv4(), cid, po.product_id, qty]);
    }

    await client.query(
      `INSERT INTO inventory_events (id, company_id, product_id, event_type, quantity_delta, to_location_type, unit_cost, notes)
       VALUES ($1, $2, $3, 'purchase_received', $4, 'warehouse', $5, $6)`,
      [uuidv4(), cid, po.product_id, qty, po.unit_cost, `PO received: ${po.purchase_order_ref || po.id}`]
    );

    await client.query('COMMIT');

    const { rows } = await pool.query(`SELECT pp.*, p.name as product_name FROM product_purchases pp JOIN vending_products p ON p.id=pp.product_id WHERE pp.id=$1`, [po.id]);
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// PUT /:id — update PO details (only if still 'ordered')
router.put('/:id', async (req, res) => {
  try {
    const pool = getDb();
    const { rows: poRows } = await pool.query('SELECT * FROM product_purchases WHERE id=$1 AND company_id=$2', [req.params.id, req.user.company_id]);
    const po = poRows[0];
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status !== 'ordered') return res.status(400).json({ error: 'Can only edit pending orders' });
    const { quantity, unit_cost, supplier, purchase_order_ref, notes } = req.body;
    const newQty = Number(quantity ?? po.quantity);
    const newCost = Number(unit_cost ?? po.unit_cost);
    await pool.query(
      `UPDATE product_purchases SET quantity=$1, unit_cost=$2, total_cost=$3, supplier=$4, purchase_order_ref=$5, notes=$6 WHERE id=$7`,
      [newQty, newCost, Math.round(newQty * newCost * 100) / 100,
        supplier ?? po.supplier, purchase_order_ref ?? po.purchase_order_ref, notes ?? po.notes, po.id]
    );
    const { rows } = await pool.query(`SELECT pp.*, p.name as product_name FROM product_purchases pp JOIN vending_products p ON p.id=pp.product_id WHERE pp.id=$1`, [po.id]);
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// DELETE /:id — cancel/delete order (only if 'ordered')
router.delete('/:id', async (req, res) => {
  try {
    const pool = getDb();
    const { rows: poRows } = await pool.query('SELECT * FROM product_purchases WHERE id=$1 AND company_id=$2', [req.params.id, req.user.company_id]);
    if (!poRows[0]) return res.status(404).json({ error: 'Not found' });
    await pool.query('UPDATE product_purchases SET status=$1 WHERE id=$2', ['cancelled', poRows[0].id]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
