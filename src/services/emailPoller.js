/**
 * Email Auto-Import Service
 * Polls an IMAP inbox for Cantaloupe CSV attachments and auto-imports them.
 *
 * Required env vars:
 *   EMAIL_IMAP_HOST      - e.g. imap.gmail.com
 *   EMAIL_IMAP_PORT      - default 993
 *   EMAIL_IMAP_TLS       - 'true' (default) or 'false'
 *   EMAIL_USER           - email address
 *   EMAIL_PASS           - password or app password
 *   EMAIL_COMPANY_ID     - company UUID to import data under
 *   EMAIL_POLL_INTERVAL_MINS - default 15
 */

const Imap = require('imap')
const { simpleParser } = require('mailparser')
const { importTransactionLineItems, importActivityAnalysis } = require('./importer')

const state = {
  enabled: false,
  running: false,
  lastRun: null,
  lastError: null,
  lastResult: null,
  totalImported: 0,
  intervalHandle: null,
}

/**
 * Detect Cantaloupe CSV type from filename.
 * Returns 'transaction-line-items', 'activity-analysis', or null.
 */
function detectCsvType(filename) {
  const lower = (filename || '').toLowerCase()
  if (lower.includes('transaction line item') || lower.includes('transaction_line_item')) {
    return 'transaction-line-items'
  }
  if (
    lower.includes('activity analysis') ||
    lower.includes('activity_analysis') ||
    lower.includes('activity summary') ||
    lower.includes('activity_summary') ||
    lower.includes('sales rollup') ||
    lower.includes('sales_rollup')
  ) {
    return 'activity-analysis'
  }
  return null
}

/**
 * Poll IMAP inbox once. Fetches UNSEEN emails, imports any Cantaloupe CSV attachments.
 */
function pollMailbox(companyId) {
  if (state.running) {
    return Promise.resolve({ skipped: true, reason: 'already running' })
  }

  const cfg = {
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASS,
    host: process.env.EMAIL_IMAP_HOST,
    port: parseInt(process.env.EMAIL_IMAP_PORT || '993', 10),
    tls: process.env.EMAIL_IMAP_TLS !== 'false',
    tlsOptions: { rejectUnauthorized: false },
    authTimeout: 10000,
    connTimeout: 15000,
  }

  if (!cfg.user || !cfg.password || !cfg.host) {
    const err = 'Email poller not configured — missing EMAIL_USER, EMAIL_PASS, or EMAIL_IMAP_HOST'
    state.lastError = err
    return Promise.resolve({ error: err })
  }

  state.running = true
  state.lastRun = new Date().toISOString()
  state.lastError = null

  return new Promise((resolve) => {
    const imap = new Imap(cfg)
    let settled = false

    const done = (result) => {
      if (settled) return
      settled = true
      state.running = false
      if (result.error) state.lastError = result.error
      else state.lastResult = result
      try { imap.end() } catch {}
      resolve(result)
    }

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) return done({ error: err.message })

        imap.search(['UNSEEN'], (err, uids) => {
          if (err) return done({ error: err.message })
          if (!uids || uids.length === 0) return done({ found: 0, imported: 0 })

          const rawMessages = []
          const fetcher = imap.fetch(uids, { bodies: '', markSeen: true })

          fetcher.on('message', (msg) => {
            const chunks = []
            msg.on('body', (stream) => {
              stream.on('data', (chunk) => chunks.push(chunk))
            })
            msg.once('end', () => rawMessages.push(Buffer.concat(chunks)))
          })

          fetcher.once('error', (err) => done({ error: err.message }))

          fetcher.once('end', async () => {
            let imported = 0
            let skipped = 0
            const errors = []

            for (const raw of rawMessages) {
              try {
                const parsed = await simpleParser(raw)
                const attachments = parsed.attachments || []

                for (const att of attachments) {
                  if (!att.filename || !att.filename.toLowerCase().endsWith('.csv')) continue
                  const csvType = detectCsvType(att.filename)
                  if (!csvType) { skipped++; continue }

                  try {
                    const content = att.content.toString('utf-8')
                    if (csvType === 'transaction-line-items') {
                      const result = importTransactionLineItems(content, companyId, att.filename)
                      imported += result.rows_imported || 0
                      console.log(`[EmailPoller] Imported transaction-line-items: ${att.filename} → ${result.rows_imported} rows`)
                    } else if (csvType === 'activity-analysis') {
                      const result = importActivityAnalysis(content, companyId, att.filename)
                      imported += result.rows_imported || 0
                      console.log(`[EmailPoller] Imported activity-analysis: ${att.filename} → ${result.rows_imported} rows`)
                    }
                  } catch (importErr) {
                    errors.push(`${att.filename}: ${importErr.message}`)
                    console.error(`[EmailPoller] Import error for ${att.filename}:`, importErr.message)
                  }
                }
              } catch (parseErr) {
                errors.push(`Parse error: ${parseErr.message}`)
                console.error('[EmailPoller] Parse error:', parseErr.message)
              }
            }

            state.totalImported += imported
            done({ found: rawMessages.length, imported, skipped, errors })
          })
        })
      })
    })

    imap.once('error', (err) => done({ error: err.message }))
    imap.once('end', () => { if (!settled) done({ error: 'Connection ended unexpectedly' }) })
    imap.connect()
  })
}

/**
 * Start the background polling interval. Called from server.js on startup.
 */
function startPoller() {
  const companyId = process.env.EMAIL_COMPANY_ID
  if (!process.env.EMAIL_USER || !process.env.EMAIL_IMAP_HOST) {
    console.log('[EmailPoller] Not configured — set EMAIL_USER, EMAIL_IMAP_HOST, EMAIL_PASS, EMAIL_COMPANY_ID to enable')
    return
  }
  if (!companyId) {
    console.log('[EmailPoller] EMAIL_COMPANY_ID not set — poller disabled')
    return
  }

  state.enabled = true
  const intervalMins = parseInt(process.env.EMAIL_POLL_INTERVAL_MINS || '15', 10)

  // Run once immediately
  pollMailbox(companyId)
    .then((r) => console.log('[EmailPoller] Initial poll result:', r))
    .catch((e) => console.error('[EmailPoller] Initial poll error:', e))

  // Then on schedule
  state.intervalHandle = setInterval(() => {
    pollMailbox(companyId)
      .then((r) => console.log('[EmailPoller] Poll result:', r))
      .catch((e) => console.error('[EmailPoller] Poll error:', e))
  }, intervalMins * 60 * 1000)

  console.log(`[EmailPoller] Started — watching ${process.env.EMAIL_USER} every ${intervalMins} min`)
}

function getStatus() {
  return {
    configured: !!(process.env.EMAIL_USER && process.env.EMAIL_IMAP_HOST && process.env.EMAIL_COMPANY_ID),
    enabled: state.enabled,
    running: state.running,
    lastRun: state.lastRun,
    lastError: state.lastError,
    lastResult: state.lastResult,
    totalImported: state.totalImported,
    email: process.env.EMAIL_USER || null,
    intervalMins: parseInt(process.env.EMAIL_POLL_INTERVAL_MINS || '15', 10),
  }
}

module.exports = { startPoller, pollMailbox, getStatus }
