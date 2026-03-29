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
      SELECT l.*,
        COUNT(DISTINCT m.id) as machine_count
      FROM vending_locations l
      LEFT JOIN vending_machines m ON m.location_id = l.id AND m.status = 'active'
      WHERE l.company_id = $1
      GROUP BY l.id
      ORDER BY l.name
    `, [req.user.company_id]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM vending_locations WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const { name, address, city, state, zip, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const pool = getDb();
    const id = uuidv4();
    await pool.query(
      `INSERT INTO vending_locations (id, company_id, name, address, city, state, zip, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, req.user.company_id, name, address || null, city || null, state || null, zip || null, notes || null]
    );
    const { rows } = await pool.query('SELECT * FROM vending_locations WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  const { name, address, city, state, zip, notes, status } = req.body;
  try {
    const pool = getDb();
    const { rows: ex } = await pool.query('SELECT * FROM vending_locations WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    if (!ex[0]) return res.status(404).json({ error: 'Not found' });
    const existing = ex[0];
    await pool.query(
      `UPDATE vending_locations SET name=$1, address=$2, city=$3, state=$4, zip=$5, notes=$6, status=$7 WHERE id=$8`,
      [name || existing.name, address ?? existing.address, city ?? existing.city, state ?? existing.state,
        zip ?? existing.zip, notes ?? existing.notes, status || existing.status, req.params.id]
    );
    const { rows } = await pool.query('SELECT * FROM vending_locations WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const pool = getDb();
    await pool.query('UPDATE vending_locations SET status = $1 WHERE id = $2 AND company_id = $3', ['inactive', req.params.id, req.user.company_id]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
