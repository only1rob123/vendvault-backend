const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Assign or reassign product to slot
router.post('/:slotId/assign', async (req, res) => {
  const { product_id, notes } = req.body;
  try {
    const pool = getDb();
    const { rows: slotRows } = await pool.query(
      'SELECT * FROM machine_slots WHERE id = $1 AND company_id = $2',
      [req.params.slotId, req.user.company_id]
    );
    if (!slotRows[0]) return res.status(404).json({ error: 'Slot not found' });

    // Close existing assignment
    await pool.query(
      `UPDATE slot_product_assignments SET is_current = false, removed_at = NOW() WHERE slot_id = $1 AND is_current = true`,
      [req.params.slotId]
    );

    if (product_id) {
      await pool.query(
        `INSERT INTO slot_product_assignments (id, company_id, slot_id, product_id, is_current, notes) VALUES ($1, $2, $3, $4, true, $5)`,
        [uuidv4(), req.user.company_id, req.params.slotId, product_id, notes || null]
      );
    }

    const { rows } = await pool.query(`
      SELECT s.*, p.name as product_name, p.category, p.sell_price, p.purchase_price,
        spa.id as assignment_id, spa.assigned_at
      FROM machine_slots s
      LEFT JOIN slot_product_assignments spa ON spa.slot_id = s.id AND spa.is_current = true
      LEFT JOIN vending_products p ON p.id = spa.product_id
      WHERE s.id = $1
    `, [req.params.slotId]);

    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Update slot stock quantity
router.patch('/:slotId/stock', async (req, res) => {
  const { quantity, notes } = req.body;
  try {
    const pool = getDb();
    const { rows: slotRows } = await pool.query(
      'SELECT * FROM machine_slots WHERE id = $1 AND company_id = $2',
      [req.params.slotId, req.user.company_id]
    );
    if (!slotRows[0]) return res.status(404).json({ error: 'Slot not found' });
    const slot = slotRows[0];

    const delta = quantity - slot.current_quantity;
    await pool.query('UPDATE machine_slots SET current_quantity = $1 WHERE id = $2', [quantity, req.params.slotId]);

    const { rows: spaRows } = await pool.query(
      'SELECT * FROM slot_product_assignments WHERE slot_id = $1 AND is_current = true',
      [req.params.slotId]
    );
    if (spaRows[0] && delta !== 0) {
      await pool.query(
        `INSERT INTO inventory_events (id, company_id, product_id, event_type, quantity_delta, slot_id, notes, occurred_at)
         VALUES ($1, $2, $3, 'adjustment', $4, $5, $6, NOW())`,
        [uuidv4(), req.user.company_id, spaRows[0].product_id, delta, req.params.slotId, notes || 'Manual stock adjustment']
      );
    }

    res.json({ success: true, quantity });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Get slot performance history
router.get('/:slotId/performance', async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query(`
      SELECT spa.product_id, p.name as product_name, spa.assigned_at, spa.removed_at,
        COUNT(vs.id) as units_sold,
        SUM(vs.line_item_price) as revenue,
        ROUND(COUNT(vs.id) * 1.0 / GREATEST(1,
          EXTRACT(EPOCH FROM (COALESCE(spa.removed_at, NOW()) - spa.assigned_at)) / 86400
        )::numeric, 2) as daily_velocity
      FROM slot_product_assignments spa
      JOIN vending_products p ON p.id = spa.product_id
      LEFT JOIN vending_sales vs ON vs.slot_id = spa.slot_id
        AND vs.product_id = spa.product_id
        AND vs.sold_at >= spa.assigned_at
        AND (spa.removed_at IS NULL OR vs.sold_at <= spa.removed_at)
      WHERE spa.slot_id = $1 AND spa.company_id = $2
      GROUP BY spa.id, p.name
      ORDER BY spa.assigned_at DESC
    `, [req.params.slotId, req.user.company_id]);

    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Create a new slot for a machine
router.post('/machine/:machineId', async (req, res) => {
  const { slot_code, row_index, col_index, capacity } = req.body;
  if (!slot_code) return res.status(400).json({ error: 'slot_code required' });
  try {
    const pool = getDb();
    const id = uuidv4();
    await pool.query(
      `INSERT INTO machine_slots (id, company_id, machine_id, slot_code, row_index, col_index, capacity) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, req.user.company_id, req.params.machineId, slot_code, row_index || 0, col_index || 0, capacity || 10]
    );
    const { rows } = await pool.query('SELECT * FROM machine_slots WHERE id = $1', [id]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Slot code already exists on this machine' });
    console.error(e); res.status(500).json({ error: e.message });
  }
});

module.exports = router;
