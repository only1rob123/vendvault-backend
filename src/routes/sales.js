const express = require('express');
const { getDb } = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

router.get('/', async (req, res) => {
  try {
    const pool = getDb();
    const { machine_id, product_id, from, to, limit = 100, offset = 0 } = req.query;
    let query = `
      SELECT vs.*, vm.name as machine_name, p.name as product_name, ms.slot_code
      FROM vending_sales vs
      JOIN vending_machines vm ON vm.id = vs.machine_id
      LEFT JOIN vending_products p ON p.id = vs.product_id
      LEFT JOIN machine_slots ms ON ms.id = vs.slot_id
      WHERE vs.company_id = $1
    `;
    const params = [req.user.company_id];
    let i = 2;
    if (machine_id) { query += ` AND vs.machine_id = $${i++}`; params.push(machine_id); }
    if (product_id) { query += ` AND vs.product_id = $${i++}`; params.push(product_id); }
    if (from) { query += ` AND vs.sold_at >= $${i++}`; params.push(from); }
    if (to) { query += ` AND vs.sold_at <= $${i++}`; params.push(to); }
    query += ` ORDER BY vs.sold_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(Number(limit), Number(offset));
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
