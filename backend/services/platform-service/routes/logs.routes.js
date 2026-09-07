/**
 * Diagnostics: durable logs live in server/logs/*.log
 * GET  /api/logs/recent?source=server|crash|client&lines=80
 * POST /api/client-log  { level?, source?, message, detail? }
 */
const express = require('express')
const logger = require('../lib/logger')

const router = express.Router()

router.get('/recent', (req, res) => {
  const source = String(req.query.source || 'server')
  const lines = Number(req.query.lines) || 80
  try {
    const payload = logger.readRecent(source, lines)
    res.json({
      ok: true,
      ...payload,
      tip: 'Full log files are in the repo /logs folder: server.log, crash.log, client.log',
    })
  } catch (err) {
    logger.error('logs.recent.failed', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    logDir: logger.dir,
    files: logger.files,
    memory: process.memoryUsage(),
  })
})

router.post('/client', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const message = body.message || body.msg || 'client event'
  const detailMsg =
    (body.detail && body.detail.message) ||
    (typeof body.detail === 'string' ? body.detail : '') ||
    ''
  // Mic double-start is a benign race — don't flood the terminal as [error]
  const isBenignMicRace =
    /already started/i.test(message) || /already started/i.test(String(detailMsg))

  const detail = {
    source: body.source || 'browser',
    level: isBenignMicRace ? 'info' : body.level || 'info',
    detail: body.detail,
    href: body.href,
    userAgent: req.get('user-agent'),
  }

  if (isBenignMicRace) {
    logger.info(`[client] ${message}`, detail)
    return res.json({ ok: true, suppressed: true })
  }

  logger.client(message, detail)
  if (body.level === 'error' || body.level === 'fatal') {
    logger.error(`[client] ${message}`, detail)
  }
  res.json({ ok: true })
})

module.exports = router
