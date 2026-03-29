/**
 * POST /api/inbound/email
 * SendGrid Inbound Parse webhook — no JWT auth.
 * Identifies the company by the inbound_email_token in the recipient address:
 *   e.g.  a3f9b2c1d4e5@import.vendvault.net
 * SendGrid docs: https://docs.sendgrid.com/for-developers/parsing-email/setting-up-the-inbound-parse-webhook
 */

const express = require('express')
const multer = require('multer')
const { getDb } = require('../db/database')
const { importTransactionLineItems, importActivityAnalysis } = require('../services/importer')

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

function detectCsvType(filename) {
  const lower = (filename || '').toLowerCase()
  if (lower.includes('transaction line item') || lower.includes('transaction_line_item')) {
    return 'transaction-line-items'
  }
  if (
    lower.includes('activity analysis') || lower.includes('activity_analysis') ||
    lower.includes('activity summary') || lower.includes('activity_summary') ||
    lower.includes('sales rollup') || lower.includes('sales_rollup')
  ) {
    return 'activity-analysis'
  }
  return null
}

router.post('/email', upload.any(), async (req, res) => {
  // Always respond 200 immediately — SendGrid retries on non-200
  res.status(200).send('OK')

  try {
    const to = req.body.to || req.body.envelope || ''

    // Extract token from addresses like "abc123def456@import.vendvault.net"
    // or "VendVault Import <abc123def456@import.vendvault.net>"
    const match = to.match(/([a-f0-9]{16,})@import\.vendvault\.net/i)
    if (!match) {
      console.log('[Inbound] No valid token found in to:', to)
      return
    }

    const token = match[1].toLowerCase()
    const pool = getDb()
    const { rows } = await pool.query(
      'SELECT id FROM vend_companies WHERE inbound_email_token = $1',
      [token]
    )
    if (!rows[0]) {
      console.log('[Inbound] Unknown inbound token:', token)
      return
    }

    const companyId = rows[0].id
    const files = req.files || []

    if (files.length === 0) {
      console.log('[Inbound] Email received for company', companyId, 'but no attachments found')
      return
    }

    for (const file of files) {
      const filename = file.originalname || ''
      if (!filename.toLowerCase().endsWith('.csv')) {
        console.log('[Inbound] Skipping non-CSV attachment:', filename)
        continue
      }

      const csvType = detectCsvType(filename)
      if (!csvType) {
        console.log('[Inbound] Unrecognised CSV type, skipping:', filename)
        continue
      }

      try {
        const content = file.buffer.toString('utf-8')
        let result
        if (csvType === 'transaction-line-items') {
          result = await importTransactionLineItems(content, companyId, filename)
        } else {
          result = await importActivityAnalysis(content, companyId, filename)
        }
        console.log(`[Inbound] ${csvType} "${filename}" → ${result.rows_imported} imported, ${result.rows_skipped} skipped`)
      } catch (importErr) {
        console.error(`[Inbound] Import error for "${filename}":`, importErr.message)
      }
    }
  } catch (e) {
    console.error('[Inbound] Unexpected error:', e.message)
  }
})

module.exports = router
