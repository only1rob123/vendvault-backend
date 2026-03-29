const express = require('express')
const auth = require('../middleware/auth')
const { getStatus, pollMailbox } = require('../services/emailPoller')

const router = express.Router()
router.use(auth)

// GET /api/email-poller/status
router.get('/status', (req, res) => {
  res.json(getStatus())
})

// POST /api/email-poller/trigger  — manual poll
router.post('/trigger', async (req, res) => {
  try {
    const result = await pollMailbox(
      process.env.EMAIL_COMPANY_ID || req.user.company_id
    )
    res.json({ ok: true, result, status: getStatus() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
