const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// GET /delivery-runs — list all runs
router.get('/', async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query(`
      SELECT
        dr.id, dr.status, dr.started_at, dr.completed_at, dr.notes, dr.created_by,
        COUNT(dri.id) AS item_count,
        COALESCE(SUM(dri.quantity_pulled), 0) AS units_pulled,
        COALESCE(SUM(dri.quantity_loaded), 0) AS units_loaded
      FROM delivery_runs dr
      LEFT JOIN delivery_run_items dri ON dri.delivery_run_id = dr.id
      WHERE dr.company_id = $1
      GROUP BY dr.id
      ORDER BY dr.created_at DESC
    `, [req.user.company_id]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GET /delivery-runs/active
router.get('/active', async (req, res) => {
  try {
    const pool = getDb();
    const { rows: runRows } = await pool.query(`
      SELECT * FROM delivery_runs WHERE company_id = $1 AND status = 'active' LIMIT 1
    `, [req.user.company_id]);

    if (!runRows[0]) return res.json({ run: null });
    const run = runRows[0];

    const { rows: items } = await pool.query(`
      SELECT dri.*,
        p.name AS product_name, p.category,
        (dri.quantity_pulled - dri.quantity_loaded - dri.quantity_to_onsite - dri.quantity_returned) AS quantity_remaining
      FROM delivery_run_items dri
      JOIN vending_products p ON p.id = dri.product_id
      WHERE dri.delivery_run_id = $1 AND dri.company_id = $2
    `, [run.id, req.user.company_id]);

    res.json({ run: { ...run, items } });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GET /delivery-runs/:id
router.get('/:id', async (req, res) => {
  try {
    const pool = getDb();
    const { rows: runRows } = await pool.query(`SELECT * FROM delivery_runs WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.company_id]);
    if (!runRows[0]) return res.status(404).json({ error: 'Delivery run not found' });
    const run = runRows[0];

    const { rows: items } = await pool.query(`
      SELECT dri.*,
        p.name AS product_name, p.category,
        (dri.quantity_pulled - dri.quantity_loaded - dri.quantity_to_onsite - dri.quantity_returned) AS quantity_remaining
      FROM delivery_run_items dri
      JOIN vending_products p ON p.id = dri.product_id
      WHERE dri.delivery_run_id = $1 AND dri.company_id = $2
    `, [run.id, req.user.company_id]);

    res.json({ run, items });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST /delivery-runs — start a new run
router.post('/', async (req, res) => {
  const { items, notes } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required and must not be empty' });
  }
  const pool = getDb();
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;
    await client.query('BEGIN');

    const { rows: activeRows } = await client.query(`SELECT id FROM delivery_runs WHERE company_id = $1 AND status = 'active' LIMIT 1`, [companyId]);
    if (activeRows[0]) throw new Error('An active delivery run already exists. Complete or cancel it before starting a new one.');

    for (const item of items) {
      const { rows: whRows } = await client.query(`SELECT quantity FROM inventory_warehouse WHERE product_id = $1 AND company_id = $2`, [item.product_id, companyId]);
      if (!whRows[0] || whRows[0].quantity < item.quantity) {
        const { rows: pRows } = await client.query('SELECT name FROM vending_products WHERE id = $1', [item.product_id]);
        const name = pRows[0] ? pRows[0].name : item.product_id;
        throw new Error(`Insufficient warehouse stock for "${name}". Available: ${whRows[0] ? whRows[0].quantity : 0}, requested: ${item.quantity}`);
      }
    }

    const runId = uuidv4();
    await client.query(
      `INSERT INTO delivery_runs (id, company_id, created_by, status, notes, started_at) VALUES ($1, $2, $3, 'active', $4, NOW())`,
      [runId, companyId, req.user.id, notes || null]
    );

    const insertedItems = [];
    for (const item of items) {
      await client.query(
        `UPDATE inventory_warehouse SET quantity = quantity - $1, updated_at = NOW() WHERE product_id = $2 AND company_id = $3`,
        [item.quantity, item.product_id, companyId]
      );

      const { rows: pRows } = await client.query(`SELECT purchase_price FROM vending_products WHERE id = $1 AND company_id = $2`, [item.product_id, companyId]);
      const unitCost = pRows[0] ? (Number(pRows[0].purchase_price) || 0) : 0;

      const itemId = uuidv4();
      await client.query(
        `INSERT INTO delivery_run_items (id, delivery_run_id, company_id, product_id, quantity_pulled, quantity_loaded, quantity_to_onsite, quantity_returned, unit_cost)
         VALUES ($1, $2, $3, $4, $5, 0, 0, 0, $6)`,
        [itemId, runId, companyId, item.product_id, item.quantity, unitCost]
      );

      await client.query(
        `INSERT INTO inventory_events (id, company_id, product_id, event_type, quantity_delta, from_location_type, from_location_id, to_location_type, to_location_id, unit_cost, delivery_run_id)
         VALUES ($1, $2, $3, 'delivery_pull', $4, 'warehouse', NULL, NULL, NULL, $5, $6)`,
        [uuidv4(), companyId, item.product_id, item.quantity, unitCost, runId]
      );

      insertedItems.push({ id: itemId, delivery_run_id: runId, company_id: companyId, product_id: item.product_id, quantity_pulled: item.quantity, quantity_loaded: 0, quantity_to_onsite: 0, quantity_returned: 0, unit_cost: unitCost });
    }

    await client.query('COMMIT');

    const { rows: runRows } = await pool.query('SELECT * FROM delivery_runs WHERE id = $1', [runId]);
    res.status(201).json({ run: runRows[0], items: insertedItems });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /delivery-runs/:id/load-machine
router.post('/:id/load-machine', async (req, res) => {
  const { machine_id, items } = req.body;
  if (!machine_id || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'machine_id and items array are required' });
  }
  const pool = getDb();
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;
    await client.query('BEGIN');

    const { rows: runRows } = await client.query(`SELECT * FROM delivery_runs WHERE id = $1 AND company_id = $2`, [req.params.id, companyId]);
    if (!runRows[0]) throw new Error('Delivery run not found');
    if (runRows[0].status !== 'active') throw new Error('Delivery run is not active');

    let totalLoaded = 0;
    let itemsUpdated = 0;

    for (const item of items) {
      const { rows: driRows } = await client.query(
        `SELECT * FROM delivery_run_items WHERE delivery_run_id = $1 AND product_id = $2 AND company_id = $3`,
        [req.params.id, item.product_id, companyId]
      );
      const dri = driRows[0];
      if (!dri) throw new Error(`Product ${item.product_id} not in this delivery run`);

      const remaining = dri.quantity_pulled - dri.quantity_loaded - dri.quantity_to_onsite - dri.quantity_returned;
      if (remaining < item.quantity) throw new Error(`Insufficient remaining quantity for product ${item.product_id}. Remaining: ${remaining}, requested: ${item.quantity}`);

      const { rows: slotRows } = await client.query(
        `SELECT * FROM machine_slots WHERE id = $1 AND machine_id = $2 AND company_id = $3`,
        [item.slot_id, machine_id, companyId]
      );
      if (!slotRows[0]) throw new Error(`Slot ${item.slot_id} not found on machine ${machine_id}`);

      await client.query(`UPDATE machine_slots SET current_quantity = current_quantity + $1 WHERE id = $2`, [item.quantity, item.slot_id]);
      await client.query(
        `UPDATE delivery_run_items SET quantity_loaded = quantity_loaded + $1 WHERE delivery_run_id = $2 AND product_id = $3 AND company_id = $4`,
        [item.quantity, req.params.id, item.product_id, companyId]
      );
      await client.query(
        `INSERT INTO inventory_events (id, company_id, product_id, event_type, quantity_delta, from_location_type, to_location_type, to_location_id, slot_id, unit_cost, delivery_run_id)
         VALUES ($1, $2, $3, 'delivery_load', $4, NULL, 'machine', $5, $6, $7, $8)`,
        [uuidv4(), companyId, item.product_id, item.quantity, machine_id, item.slot_id, dri.unit_cost, req.params.id]
      );

      totalLoaded += item.quantity;
      itemsUpdated += 1;
    }

    await client.query('COMMIT');
    res.json({ total_loaded: totalLoaded, items_updated: itemsUpdated });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /delivery-runs/:id/store-onsite
router.post('/:id/store-onsite', async (req, res) => {
  const { location_id, items } = req.body;
  if (!location_id || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'location_id and items array are required' });
  }
  const pool = getDb();
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;
    await client.query('BEGIN');

    const { rows: runRows } = await client.query(`SELECT * FROM delivery_runs WHERE id = $1 AND company_id = $2`, [req.params.id, companyId]);
    if (!runRows[0]) throw new Error('Delivery run not found');
    if (runRows[0].status !== 'active') throw new Error('Delivery run is not active');

    for (const item of items) {
      const { rows: driRows } = await client.query(
        `SELECT * FROM delivery_run_items WHERE delivery_run_id = $1 AND product_id = $2 AND company_id = $3`,
        [req.params.id, item.product_id, companyId]
      );
      const dri = driRows[0];
      if (!dri) throw new Error(`Product ${item.product_id} not in this delivery run`);

      const remaining = dri.quantity_pulled - dri.quantity_loaded - dri.quantity_to_onsite - dri.quantity_returned;
      if (remaining < item.quantity) throw new Error(`Insufficient remaining quantity for product ${item.product_id}. Remaining: ${remaining}, requested: ${item.quantity}`);

      const { rows: osRows } = await client.query(
        `SELECT * FROM inventory_onsite WHERE company_id = $1 AND location_id = $2 AND product_id = $3`,
        [companyId, location_id, item.product_id]
      );
      if (osRows[0]) {
        await client.query(`UPDATE inventory_onsite SET quantity = quantity + $1, updated_at = NOW() WHERE company_id = $2 AND location_id = $3 AND product_id = $4`, [item.quantity, companyId, location_id, item.product_id]);
      } else {
        await client.query(`INSERT INTO inventory_onsite (id, company_id, location_id, product_id, quantity) VALUES ($1, $2, $3, $4, $5)`, [uuidv4(), companyId, location_id, item.product_id, item.quantity]);
      }

      await client.query(
        `UPDATE delivery_run_items SET quantity_to_onsite = quantity_to_onsite + $1 WHERE delivery_run_id = $2 AND product_id = $3 AND company_id = $4`,
        [item.quantity, req.params.id, item.product_id, companyId]
      );
      await client.query(
        `INSERT INTO inventory_events (id, company_id, product_id, event_type, quantity_delta, from_location_type, to_location_type, to_location_id, unit_cost, delivery_run_id)
         VALUES ($1, $2, $3, 'delivery_store_onsite', $4, NULL, 'onsite', $5, $6, $7)`,
        [uuidv4(), companyId, item.product_id, item.quantity, location_id, dri.unit_cost, req.params.id]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /delivery-runs/:id/return
router.post('/:id/return', async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }
  const pool = getDb();
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;
    await client.query('BEGIN');

    const { rows: runRows } = await client.query(`SELECT * FROM delivery_runs WHERE id = $1 AND company_id = $2`, [req.params.id, companyId]);
    if (!runRows[0]) throw new Error('Delivery run not found');
    if (runRows[0].status !== 'active') throw new Error('Delivery run is not active');

    for (const item of items) {
      const { rows: driRows } = await client.query(
        `SELECT * FROM delivery_run_items WHERE delivery_run_id = $1 AND product_id = $2 AND company_id = $3`,
        [req.params.id, item.product_id, companyId]
      );
      const dri = driRows[0];
      if (!dri) throw new Error(`Product ${item.product_id} not in this delivery run`);

      const remaining = dri.quantity_pulled - dri.quantity_loaded - dri.quantity_to_onsite - dri.quantity_returned;
      if (remaining < item.quantity) throw new Error(`Insufficient remaining quantity for product ${item.product_id}. Remaining: ${remaining}, requested: ${item.quantity}`);

      const { rows: whRows } = await client.query(`SELECT id FROM inventory_warehouse WHERE product_id = $1 AND company_id = $2`, [item.product_id, companyId]);
      if (whRows[0]) {
        await client.query(`UPDATE inventory_warehouse SET quantity = quantity + $1, updated_at = NOW() WHERE product_id = $2 AND company_id = $3`, [item.quantity, item.product_id, companyId]);
      } else {
        await client.query(`INSERT INTO inventory_warehouse (id, company_id, product_id, quantity) VALUES ($1, $2, $3, $4)`, [uuidv4(), companyId, item.product_id, item.quantity]);
      }

      await client.query(
        `UPDATE delivery_run_items SET quantity_returned = quantity_returned + $1 WHERE delivery_run_id = $2 AND product_id = $3 AND company_id = $4`,
        [item.quantity, req.params.id, item.product_id, companyId]
      );
      await client.query(
        `INSERT INTO inventory_events (id, company_id, product_id, event_type, quantity_delta, from_location_type, to_location_type, unit_cost, delivery_run_id)
         VALUES ($1, $2, $3, 'delivery_return', $4, NULL, 'warehouse', $5, $6)`,
        [uuidv4(), companyId, item.product_id, item.quantity, dri.unit_cost, req.params.id]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /delivery-runs/:id/complete
router.post('/:id/complete', async (req, res) => {
  const { notes } = req.body || {};
  const pool = getDb();
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;
    await client.query('BEGIN');

    const { rows: runRows } = await client.query(`SELECT * FROM delivery_runs WHERE id = $1 AND company_id = $2`, [req.params.id, companyId]);
    if (!runRows[0]) throw new Error('Delivery run not found');
    if (runRows[0].status !== 'active') throw new Error('Delivery run is not active');

    const { rows: allItems } = await client.query(`SELECT * FROM delivery_run_items WHERE delivery_run_id = $1 AND company_id = $2`, [req.params.id, companyId]);

    let totalPulled = 0, totalLoaded = 0, totalStored = 0, totalReturned = 0, writtenOff = 0;

    for (const dri of allItems) {
      totalPulled += dri.quantity_pulled;
      totalLoaded += dri.quantity_loaded;
      totalStored += dri.quantity_to_onsite;
      totalReturned += dri.quantity_returned;

      const remaining = dri.quantity_pulled - dri.quantity_loaded - dri.quantity_to_onsite - dri.quantity_returned;
      if (remaining > 0) {
        await client.query(
          `INSERT INTO inventory_events (id, company_id, product_id, event_type, quantity_delta, from_location_type, unit_cost, notes, delivery_run_id)
           VALUES ($1, $2, $3, 'delivery_writeoff', $4, NULL, $5, 'Unaccounted units written off at run completion', $6)`,
          [uuidv4(), companyId, dri.product_id, remaining, dri.unit_cost, req.params.id]
        );
        writtenOff += remaining;
      }
    }

    if (notes !== undefined) {
      await client.query(
        `UPDATE delivery_runs SET status = 'completed', completed_at = NOW(), notes = $1 WHERE id = $2 AND company_id = $3`,
        [notes, req.params.id, companyId]
      );
    } else {
      await client.query(
        `UPDATE delivery_runs SET status = 'completed', completed_at = NOW() WHERE id = $1 AND company_id = $2`,
        [req.params.id, companyId]
      );
    }

    await client.query('COMMIT');

    const { rows: updatedRun } = await pool.query('SELECT * FROM delivery_runs WHERE id = $1', [req.params.id]);
    res.json({
      run: updatedRun[0],
      summary: { total_pulled: totalPulled, total_loaded: totalLoaded, total_stored: totalStored, total_returned: totalReturned, written_off: writtenOff }
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /delivery-runs/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  const pool = getDb();
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;
    await client.query('BEGIN');

    const { rows: runRows } = await client.query(`SELECT * FROM delivery_runs WHERE id = $1 AND company_id = $2`, [req.params.id, companyId]);
    if (!runRows[0]) throw new Error('Delivery run not found');
    if (runRows[0].status !== 'active') throw new Error('Delivery run is not active');

    const { rows: allItems } = await client.query(`SELECT * FROM delivery_run_items WHERE delivery_run_id = $1 AND company_id = $2`, [req.params.id, companyId]);

    let returnedToWarehouse = 0;

    for (const dri of allItems) {
      const qtyToReturn = dri.quantity_pulled - dri.quantity_loaded - dri.quantity_to_onsite - dri.quantity_returned;
      if (qtyToReturn > 0) {
        const { rows: whRows } = await client.query(`SELECT id FROM inventory_warehouse WHERE product_id = $1 AND company_id = $2`, [dri.product_id, companyId]);
        if (whRows[0]) {
          await client.query(`UPDATE inventory_warehouse SET quantity = quantity + $1, updated_at = NOW() WHERE product_id = $2 AND company_id = $3`, [qtyToReturn, dri.product_id, companyId]);
        } else {
          await client.query(`INSERT INTO inventory_warehouse (id, company_id, product_id, quantity) VALUES ($1, $2, $3, $4)`, [uuidv4(), companyId, dri.product_id, qtyToReturn]);
        }

        await client.query(
          `UPDATE delivery_run_items SET quantity_returned = quantity_returned + $1 WHERE delivery_run_id = $2 AND product_id = $3 AND company_id = $4`,
          [qtyToReturn, req.params.id, dri.product_id, companyId]
        );
        await client.query(
          `INSERT INTO inventory_events (id, company_id, product_id, event_type, quantity_delta, from_location_type, to_location_type, unit_cost, notes, delivery_run_id)
           VALUES ($1, $2, $3, 'delivery_return', $4, NULL, 'warehouse', $5, 'Returned to warehouse on run cancellation', $6)`,
          [uuidv4(), companyId, dri.product_id, qtyToReturn, dri.unit_cost, req.params.id]
        );

        returnedToWarehouse += qtyToReturn;
      }
    }

    await client.query(`UPDATE delivery_runs SET status = 'cancelled', completed_at = NOW() WHERE id = $1 AND company_id = $2`, [req.params.id, companyId]);

    await client.query('COMMIT');
    res.json({ success: true, returned_to_warehouse: returnedToWarehouse });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
