const express = require('express');
const { getDb } = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

function buildWhere(companyId, { machine_id, product_id, from, to }) {
  const params = [companyId];
  let where = 'WHERE vs.company_id = $1';
  let i = 2;
  if (machine_id) { where += ` AND vs.machine_id = $${i++}`; params.push(machine_id); }
  if (product_id) { where += ` AND vs.product_id = $${i++}`; params.push(product_id); }
  if (from)       { where += ` AND vs.sold_at >= $${i++}`; params.push(from); }
  if (to)         { where += ` AND vs.sold_at <= $${i++}`; params.push(to); }
  return { where, params, nextIdx: i };
}

// GET /sales — paginated transaction list
router.get('/', async (req, res) => {
  try {
    const pool = getDb();
    const { machine_id, product_id, from, to, limit = 50, offset = 0 } = req.query;
    const { where, params, nextIdx } = buildWhere(req.user.company_id, { machine_id, product_id, from, to });

    const query = `
      SELECT vs.id, vs.sold_at, vs.slot_code, vs.payment_method,
             vs.line_item_price, vs.two_tier_surcharge, vs.tran_amount,
             vm.name as machine_name, p.name as product_name, p.category
      FROM vending_sales vs
      JOIN vending_machines vm ON vm.id = vs.machine_id
      LEFT JOIN vending_products p ON p.id = vs.product_id
      LEFT JOIN machine_slots ms ON ms.id = vs.slot_id
      ${where}
      ORDER BY vs.sold_at DESC
      LIMIT $${nextIdx} OFFSET $${nextIdx + 1}
    `;
    params.push(Number(limit), Number(offset));
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GET /sales/count — total rows matching filters (for pagination)
router.get('/count', async (req, res) => {
  try {
    const pool = getDb();
    const { machine_id, product_id, from, to } = req.query;
    const { where, params } = buildWhere(req.user.company_id, { machine_id, product_id, from, to });
    const { rows } = await pool.query(`SELECT COUNT(*) as total FROM vending_sales vs ${where}`, params);
    res.json({ total: Number(rows[0].total) });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
