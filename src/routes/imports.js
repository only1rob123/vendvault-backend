const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const auth = require('../middleware/auth');
const { importTransactionLineItems, importActivityAnalysis } = require('../services/importer');

const router = express.Router();
router.use(auth);

const upload = multer({
  dest: path.join(__dirname, '../../uploads/'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.csv')) return cb(new Error('Only CSV files allowed'));
    cb(null, true);
  }
});

router.post('/transaction-line-items', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const content = fs.readFileSync(req.file.path, 'utf-8');
    const result = await importTransactionLineItems(content, req.user.company_id, req.file.originalname);
    fs.unlinkSync(req.file.path);
    res.json(result);
  } catch (e) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    console.error(e); res.status(500).json({ error: e.message });
  }
});

router.post('/activity-analysis', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const content = fs.readFileSync(req.file.path, 'utf-8');
    const result = await importActivityAnalysis(content, req.user.company_id, req.file.originalname);
    fs.unlinkSync(req.file.path);
    res.json(result);
  } catch (e) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    console.error(e); res.status(500).json({ error: e.message });
  }
});

router.get('/log', async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query(
      `SELECT * FROM import_log WHERE company_id = $1 ORDER BY imported_at DESC LIMIT 50`,
      [req.user.company_id]
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
