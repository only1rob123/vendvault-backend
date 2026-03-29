const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// P&L summary by machine for a given month
router.get('/pl', async (req, res) => {
  try {
    const pool = getDb();
    const cid = req.user.company_id;
    const { year, month } = req.query;
    const period = year && month ? `${year}-${String(month).padStart(2, '0')}` : strftimeNow();

    const { rows: machines } = await pool.query(`
      SELECT m.id, m.name, m.commission_pct, m.monthly_fixed_cost,
        l.name as location_name
      FROM vending_machines m
      JOIN vending_locations l ON l.id = m.location_id
      WHERE m.company_id = $1 AND m.status = 'active'
    `, [cid]);

    const result = [];
    for (const machine of machines) {
      const [salesRes, cogsRes, locationCountRes, machineCostsRes, locationCostsRes] = await Promise.all([
        pool.query(`
          SELECT COALESCE(SUM(line_item_price), 0) as gross_revenue,
            COALESCE(SUM(two_tier_surcharge), 0) as surcharge,
            COALESCE(SUM(quantity), 0) as units_sold,
            COUNT(*) as transactions
          FROM vending_sales
          WHERE company_id = $1 AND machine_id = $2 AND TO_CHAR(sold_at, 'YYYY-MM') = $3
        `, [cid, machine.id, period]),
        pool.query(`
          SELECT COALESCE(SUM(vs.quantity * p.purchase_price), 0) as total_cogs
          FROM vending_sales vs
          JOIN vending_products p ON p.id = vs.product_id
          WHERE vs.company_id = $1 AND vs.machine_id = $2 AND TO_CHAR(vs.sold_at, 'YYYY-MM') = $3
        `, [cid, machine.id, period]),
        pool.query(`
          SELECT COUNT(*) as cnt FROM vending_machines
          WHERE location_id = (SELECT location_id FROM vending_machines WHERE id = $1)
          AND company_id = $2 AND status = 'active'
        `, [machine.id, cid]),
        pool.query(`
          SELECT COALESCE(SUM(
            CASE frequency WHEN 'monthly' THEN amount WHEN 'annual' THEN amount / 12.0 ELSE 0 END
          ), 0) as total
          FROM vending_fixed_costs
          WHERE company_id = $1 AND machine_id = $2
          AND effective_from <= ($3 || '-01')::date
          AND (effective_to IS NULL OR effective_to >= ($4 || '-01')::date)
        `, [cid, machine.id, period, period]),
        pool.query(`
          SELECT COALESCE(SUM(
            CASE frequency WHEN 'monthly' THEN amount WHEN 'annual' THEN amount / 12.0 ELSE 0 END
          ), 0) as total
          FROM vending_fixed_costs
          WHERE company_id = $1 AND machine_id IS NULL
            AND location_id = (SELECT location_id FROM vending_machines WHERE id = $2)
          AND effective_from <= ($3 || '-01')::date
          AND (effective_to IS NULL OR effective_to >= ($4 || '-01')::date)
        `, [cid, machine.id, period, period]),
      ]);

      const sales = salesRes.rows[0];
      const cogs = cogsRes.rows[0];
      const locationMachineCount = Number(locationCountRes.rows[0].cnt) || 1;
      const machineCosts = Number(machineCostsRes.rows[0].total);
      const locationCosts = Number(locationCostsRes.rows[0].total);
      const totalFixedCosts = machineCosts + (locationCosts / locationMachineCount) + Number(machine.monthly_fixed_cost);

      const grossRevenue = Number(sales.gross_revenue);
      const commissionAmount = grossRevenue * (Number(machine.commission_pct) / 100);
      const netRevenue = grossRevenue - commissionAmount;
      const grossProfit = netRevenue - Number(cogs.total_cogs);
      const netProfit = grossProfit - totalFixedCosts;
      const margin = grossRevenue > 0 ? (netProfit / grossRevenue) * 100 : 0;

      result.push({
        machine_id: machine.id,
        machine_name: machine.name,
        location_name: machine.location_name,
        period,
        gross_revenue: round(grossRevenue),
        surcharge: round(Number(sales.surcharge)),
        commission_pct: machine.commission_pct,
        commission_amount: round(commissionAmount),
        net_revenue: round(netRevenue),
        cogs: round(Number(cogs.total_cogs)),
        gross_profit: round(grossProfit),
        fixed_costs: round(totalFixedCosts),
        net_profit: round(netProfit),
        margin_pct: round(margin),
        units_sold: sales.units_sold,
        transactions: sales.transactions,
      });
    }

    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Fixed costs CRUD
router.get('/fixed-costs', async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query(`
      SELECT fc.*, vm.name as machine_name, vl.name as location_name
      FROM vending_fixed_costs fc
      LEFT JOIN vending_machines vm ON vm.id = fc.machine_id
      LEFT JOIN vending_locations vl ON vl.id = fc.location_id
      WHERE fc.company_id = $1
      ORDER BY fc.effective_from DESC
    `, [req.user.company_id]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.post('/fixed-costs', async (req, res) => {
  const { machine_id, location_id, cost_type, description, amount, frequency, effective_from, effective_to } = req.body;
  if (!cost_type || !description || !amount || !effective_from) {
    return res.status(400).json({ error: 'cost_type, description, amount, effective_from required' });
  }
  try {
    const pool = getDb();
    const id = uuidv4();
    await pool.query(
      `INSERT INTO vending_fixed_costs (id, company_id, machine_id, location_id, cost_type, description, amount, frequency, effective_from, effective_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, req.user.company_id, machine_id || null, location_id || null, cost_type, description,
        amount, frequency || 'monthly', effective_from, effective_to || null]
    );
    const { rows } = await pool.query('SELECT * FROM vending_fixed_costs WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.put('/fixed-costs/:id', async (req, res) => {
  try {
    const pool = getDb();
    const { rows: ex } = await pool.query('SELECT * FROM vending_fixed_costs WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    if (!ex[0]) return res.status(404).json({ error: 'Not found' });
    const existing = ex[0];
    const { cost_type, description, amount, frequency, effective_from, effective_to } = req.body;
    await pool.query(
      `UPDATE vending_fixed_costs SET cost_type=$1, description=$2, amount=$3, frequency=$4, effective_from=$5, effective_to=$6 WHERE id=$7`,
      [cost_type ?? existing.cost_type, description ?? existing.description,
        amount ?? existing.amount, frequency ?? existing.frequency,
        effective_from ?? existing.effective_from,
        effective_to !== undefined ? effective_to : existing.effective_to,
        req.params.id]
    );
    const { rows } = await pool.query('SELECT * FROM vending_fixed_costs WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.delete('/fixed-costs/:id', async (req, res) => {
  try {
    const pool = getDb();
    await pool.query('DELETE FROM vending_fixed_costs WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

function strftimeNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function round(n) { return Math.round(n * 100) / 100; }

module.exports = router;
