const express = require('express');
const { getDb } = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Dashboard KPIs
router.get('/kpis', async (req, res) => {
  try {
    const pool = getDb();
    const cid = req.user.company_id;

    const [todayRes, thisMonthRes, lastMonthRes, machinesRes, productsRes, lowStockRes, emptySlotsRes] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(line_item_price), 0) as revenue, COUNT(*) as transactions FROM vending_sales WHERE company_id = $1 AND sold_at::date = CURRENT_DATE`, [cid]),
      pool.query(`SELECT COALESCE(SUM(line_item_price), 0) as revenue, COUNT(*) as transactions FROM vending_sales WHERE company_id = $1 AND TO_CHAR(sold_at, 'YYYY-MM') = TO_CHAR(NOW(), 'YYYY-MM')`, [cid]),
      pool.query(`SELECT COALESCE(SUM(line_item_price), 0) as revenue FROM vending_sales WHERE company_id = $1 AND TO_CHAR(sold_at, 'YYYY-MM') = TO_CHAR(NOW() - INTERVAL '1 month', 'YYYY-MM')`, [cid]),
      pool.query(`SELECT COUNT(*) as count FROM vending_machines WHERE company_id = $1 AND status = 'active'`, [cid]),
      pool.query(`SELECT COUNT(*) as count FROM vending_products WHERE company_id = $1 AND status = 'active'`, [cid]),
      pool.query(`SELECT COUNT(*) as count FROM machine_slots ms JOIN vending_machines vm ON vm.id = ms.machine_id JOIN slot_product_assignments spa ON spa.slot_id = ms.id AND spa.is_current = true WHERE vm.company_id = $1 AND ms.current_quantity <= (ms.capacity * 0.25) AND ms.current_quantity >= 0`, [cid]),
      pool.query(`SELECT COUNT(*) as count FROM machine_slots ms JOIN vending_machines vm ON vm.id = ms.machine_id JOIN slot_product_assignments spa ON spa.slot_id = ms.id AND spa.is_current = true WHERE vm.company_id = $1 AND ms.current_quantity = 0`, [cid]),
    ]);

    const today = todayRes.rows[0];
    const thisMonth = thisMonthRes.rows[0];
    const lastMonth = lastMonthRes.rows[0];

    res.json({
      today_revenue: today.revenue,
      today_transactions: today.transactions,
      month_revenue: thisMonth.revenue,
      month_transactions: thisMonth.transactions,
      last_month_revenue: lastMonth.revenue,
      active_machines: machinesRes.rows[0].count,
      active_products: productsRes.rows[0].count,
      low_stock_slots: lowStockRes.rows[0].count,
      empty_slots: emptySlotsRes.rows[0].count,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Daily revenue chart (last N days)
router.get('/revenue/daily', async (req, res) => {
  try {
    const pool = getDb();
    const { days = 30, machine_id } = req.query;
    let query = `
      SELECT sold_at::date as day,
        ROUND(SUM(line_item_price)::numeric, 2) as revenue,
        COUNT(*) as transactions,
        SUM(quantity) as units
      FROM vending_sales
      WHERE company_id = $1 AND sold_at >= NOW() - ($2 * INTERVAL '1 day')
    `;
    const params = [req.user.company_id, Number(days)];
    let i = 3;
    if (machine_id) { query += ` AND machine_id = $${i++}`; params.push(machine_id); }
    query += ' GROUP BY sold_at::date ORDER BY day ASC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Revenue by machine
router.get('/revenue/by-machine', async (req, res) => {
  try {
    const pool = getDb();
    const { days = 30 } = req.query;
    const { rows } = await pool.query(`
      SELECT vs.machine_id, vm.name as machine_name, vl.name as location_name,
        ROUND(SUM(vs.line_item_price)::numeric, 2) as revenue,
        COUNT(*) as transactions,
        SUM(vs.quantity) as units
      FROM vending_sales vs
      JOIN vending_machines vm ON vm.id = vs.machine_id
      JOIN vending_locations vl ON vl.id = vm.location_id
      WHERE vs.company_id = $1 AND vs.sold_at >= NOW() - ($2 * INTERVAL '1 day')
      GROUP BY vs.machine_id, vm.name, vl.name
      ORDER BY revenue DESC
    `, [req.user.company_id, Number(days)]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Top products by velocity
router.get('/products/velocity', async (req, res) => {
  try {
    const pool = getDb();
    const { days = 30, machine_id } = req.query;
    let query = `
      SELECT vs.product_id, p.name as product_name, p.category,
        p.sell_price, p.purchase_price,
        SUM(vs.quantity) as units_sold,
        ROUND(SUM(vs.line_item_price)::numeric, 2) as revenue,
        ROUND((SUM(vs.line_item_price) - (SUM(vs.quantity) * p.purchase_price))::numeric, 2) as gross_profit,
        ROUND((SUM(vs.quantity) * 1.0 / $1)::numeric, 2) as daily_velocity
      FROM vending_sales vs
      JOIN vending_products p ON p.id = vs.product_id
      WHERE vs.company_id = $2 AND vs.sold_at >= NOW() - ($3 * INTERVAL '1 day') AND vs.product_id IS NOT NULL
    `;
    const params = [Number(days), req.user.company_id, Number(days)];
    let i = 4;
    if (machine_id) { query += ` AND vs.machine_id = $${i++}`; params.push(machine_id); }
    query += ' GROUP BY vs.product_id, p.name, p.category, p.sell_price, p.purchase_price ORDER BY units_sold DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Hour of day distribution
router.get('/sales/by-hour', async (req, res) => {
  try {
    const pool = getDb();
    const { days = 30, machine_id } = req.query;
    let query = `
      SELECT EXTRACT(HOUR FROM sold_at)::integer as hour,
        COUNT(*) as transactions, SUM(quantity) as units,
        ROUND(SUM(line_item_price)::numeric, 2) as revenue
      FROM vending_sales
      WHERE company_id = $1 AND sold_at >= NOW() - ($2 * INTERVAL '1 day')
    `;
    const params = [req.user.company_id, Number(days)];
    let i = 3;
    if (machine_id) { query += ` AND machine_id = $${i++}`; params.push(machine_id); }
    query += ' GROUP BY hour ORDER BY hour ASC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Day of week distribution
router.get('/sales/by-dow', async (req, res) => {
  try {
    const pool = getDb();
    const { days = 90, machine_id } = req.query;
    let query = `
      SELECT EXTRACT(DOW FROM sold_at)::integer as dow,
        COUNT(*) as transactions, SUM(quantity) as units,
        ROUND(SUM(line_item_price)::numeric, 2) as revenue
      FROM vending_sales
      WHERE company_id = $1 AND sold_at >= NOW() - ($2 * INTERVAL '1 day')
    `;
    const params = [req.user.company_id, Number(days)];
    let i = 3;
    if (machine_id) { query += ` AND machine_id = $${i++}`; params.push(machine_id); }
    query += ' GROUP BY dow ORDER BY dow ASC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Monthly trend (seasonality)
router.get('/revenue/monthly', async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query(`
      SELECT TO_CHAR(sold_at, 'YYYY-MM') as month,
        ROUND(SUM(line_item_price)::numeric, 2) as revenue,
        COUNT(*) as transactions,
        SUM(quantity) as units
      FROM vending_sales
      WHERE company_id = $1
      GROUP BY month
      ORDER BY month ASC
    `, [req.user.company_id]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Payment method breakdown
router.get('/sales/by-payment', async (req, res) => {
  try {
    const pool = getDb();
    const { days = 30 } = req.query;
    const { rows } = await pool.query(`
      SELECT payment_method, COUNT(*) as transactions,
        ROUND(SUM(line_item_price)::numeric, 2) as revenue,
        ROUND(SUM(two_tier_surcharge)::numeric, 2) as surcharge_total
      FROM vending_sales
      WHERE company_id = $1 AND sold_at >= NOW() - ($2 * INTERVAL '1 day')
      GROUP BY payment_method
    `, [req.user.company_id, Number(days)]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Slot performance
router.get('/slots/performance', async (req, res) => {
  try {
    const pool = getDb();
    const { machine_id, days = 30 } = req.query;
    let query = `
      SELECT ms.id as slot_id, ms.slot_code, ms.current_quantity, ms.capacity,
        vm.name as machine_name, vm.id as machine_id,
        p.name as product_name, p.category, p.sell_price, p.purchase_price,
        COUNT(vs.id) as units_sold,
        ROUND(SUM(vs.line_item_price)::numeric, 2) as revenue,
        ROUND((COUNT(vs.id) * 1.0 / $1)::numeric, 2) as daily_velocity
      FROM machine_slots ms
      JOIN vending_machines vm ON vm.id = ms.machine_id
      LEFT JOIN slot_product_assignments spa ON spa.slot_id = ms.id AND spa.is_current = true
      LEFT JOIN vending_products p ON p.id = spa.product_id
      LEFT JOIN vending_sales vs ON vs.slot_id = ms.id AND vs.sold_at >= NOW() - ($2 * INTERVAL '1 day')
      WHERE vm.company_id = $3
    `;
    const params = [Number(days), Number(days), req.user.company_id];
    let i = 4;
    if (machine_id) { query += ` AND vm.id = $${i++}`; params.push(machine_id); }
    query += ' GROUP BY ms.id, ms.slot_code, ms.current_quantity, ms.capacity, vm.name, vm.id, p.name, p.category, p.sell_price, p.purchase_price ORDER BY units_sold DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
