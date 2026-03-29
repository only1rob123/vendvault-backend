const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDb } = require('../db/database');

const router = express.Router();

// POST /api/auth/register — create new company + admin user
router.post('/register', async (req, res) => {
  const { company_name, name, email, password } = req.body;
  if (!company_name || !name || !email || !password)
    return res.status(400).json({ error: 'Company name, your name, email and password are required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const pool = getDb();

    // Check email not already in use
    const { rows: existing } = await pool.query('SELECT id FROM vend_users WHERE email = $1', [email]);
    if (existing[0]) return res.status(409).json({ error: 'An account with that email already exists' });

    // Generate unique slug from company name
    const baseSlug = company_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let slug = baseSlug;
    let attempt = 0;
    while (true) {
      const { rows: slugCheck } = await pool.query('SELECT id FROM vend_companies WHERE slug = $1', [slug]);
      if (!slugCheck[0]) break;
      attempt++;
      slug = `${baseSlug}-${attempt}`;
    }

    const companyId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const inboundToken = crypto.randomBytes(12).toString('hex');
    const passwordHash = await bcrypt.hash(password, 12);

    // Create company
    await pool.query(
      `INSERT INTO vend_companies (id, name, slug, plan, inbound_email_token)
       VALUES ($1, $2, $3, 'trial', $4)`,
      [companyId, company_name, slug, inboundToken]
    );

    // Create admin user
    await pool.query(
      `INSERT INTO vend_users (id, company_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, $5, 'admin')`,
      [userId, companyId, email, passwordHash, name]
    );

    const token = jwt.sign(
      { id: userId, company_id: companyId, email, name, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: { id: userId, email, name, role: 'admin', company_id: companyId }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const pool = getDb();
    const { rows } = await pool.query('SELECT * FROM vend_users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: user.id, company_id: user.company_id, email: user.email, name: user.name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, company_id: user.company_id } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', require('../middleware/auth'), (req, res) => {
  res.json({ user: req.user });
});

// GET /api/auth/company — returns company details including inbound email token
router.get('/company', require('../middleware/auth'), async (req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query(
      'SELECT id, name, slug, plan, inbound_email_token FROM vend_companies WHERE id = $1',
      [req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Company not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
