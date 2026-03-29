const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

router.get('/', async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query(`
      SELECT p.*,
        COALESCE(iw.quantity, 0) as warehouse_qty,
        COUNT(DISTINCT CASE WHEN spa.is_current = true THEN spa.id END) as active_slots
      FROM vending_products p
      LEFT JOIN inventory_warehouse iw ON iw.product_id = p.id AND iw.company_id = p.company_id
      LEFT JOIN slot_product_assignments spa ON spa.product_id = p.id
      WHERE p.company_id = $1
      GROUP BY p.id, iw.quantity
      ORDER BY p.name
    `, [req.user.company_id]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const pool = getDb();
    const { rows: pRows } = await pool.query('SELECT * FROM vending_products WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    if (!pRows[0]) return res.status(404).json({ error: 'Not found' });
    const product = pRows[0];

    const { rows: slots } = await pool.query(`
      SELECT spa.*, ms.slot_code, ms.current_quantity, ms.capacity,
        vm.name as machine_name, vl.name as location_name
      FROM slot_product_assignments spa
      JOIN machine_slots ms ON ms.id = spa.slot_id
      JOIN vending_machines vm ON vm.id = ms.machine_id
      JOIN vending_locations vl ON vl.id = vm.location_id
      WHERE spa.product_id = $1 AND spa.company_id = $2
      ORDER BY spa.assigned_at DESC
    `, [req.params.id, req.user.company_id]);

    const { rows: salesRows } = await pool.query(`
      SELECT COUNT(*) as units_sold, SUM(line_item_price) as revenue, SUM(two_tier_surcharge) as surcharge
      FROM vending_sales
      WHERE product_id = $1 AND company_id = $2 AND sold_at >= NOW() - INTERVAL '30 days'
    `, [req.params.id, req.user.company_id]);

    res.json({ ...product, slots, sales_30d: salesRows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const { name, sku, barcode, category, purchase_price, sell_price, unit_size } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const pool = getDb();
    const id = uuidv4();
    await pool.query(
      `INSERT INTO vending_products (id, company_id, name, sku, barcode, category, purchase_price, sell_price, unit_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, req.user.company_id, name, sku || null, barcode || null, category || 'snack',
        purchase_price || 0, sell_price || 0, unit_size || null]
    );
    // Init warehouse record
    await pool.query(
      `INSERT INTO inventory_warehouse (id, company_id, product_id, quantity, reorder_threshold) VALUES ($1, $2, $3, 0, 12) ON CONFLICT DO NOTHING`,
      [uuidv4(), req.user.company_id, id]
    );
    const { rows } = await pool.query('SELECT * FROM vending_products WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const pool = getDb();
    const { rows: ex } = await pool.query('SELECT * FROM vending_products WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    if (!ex[0]) return res.status(404).json({ error: 'Not found' });
    const existing = ex[0];
    const { name, sku, barcode, category, purchase_price, sell_price, unit_size, status } = req.body;
    await pool.query(
      `UPDATE vending_products SET name=$1, sku=$2, barcode=$3, category=$4, purchase_price=$5, sell_price=$6, unit_size=$7, status=$8 WHERE id=$9`,
      [name ?? existing.name, sku ?? existing.sku, barcode ?? existing.barcode,
        category ?? existing.category, purchase_price ?? existing.purchase_price,
        sell_price ?? existing.sell_price, unit_size ?? existing.unit_size,
        status ?? existing.status, req.params.id]
    );
    const { rows } = await pool.query('SELECT * FROM vending_products WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
