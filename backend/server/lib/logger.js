/**
 * Durable file + console logger for MultiChat server.
 * Sync appends so crash logs survive process.exit().
 *
 * All files go in the repo-root /logs folder:
 *   MERN-Multichat/logs/server.log
 *   MERN-Multichat/logs/crash.log
 *   MERN-Multichat/logs/client.log
 *
 * Nodemon MUST ignore that folder or logging will restart the server.
 */
const fs = require('fs')
const path = require('path')

// server/lib → ../../.. = repo root (MERN-Multichat) on a normal checkout.
// In Docker the tree is shorter, so LOG_DIR can be set explicitly.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const LOG_DIR = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.join(REPO_ROOT, 'logs')
const SERVER_LOG = path.join(LOG_DIR, 'server.log')
const CRASH_LOG = path.join(LOG_DIR, 'crash.log')
const CLIENT_LOG = path.join(LOG_DIR, 'client.log')
const MAX_BYTES = 5 * 1024 * 1024 // 5 MB per file before rotate

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
  } catch {
    /* ignore */
  }
}

function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return
    const { size } = fs.statSync(filePath)
    if (size < MAX_BYTES) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const rotated = `${filePath}.${stamp}`
    fs.renameSync(filePath, rotated)
  } catch {
    /* ignore */
  }
}

function safeSerialize(value) {
  if (value == null) return undefined
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      code: value.code,
    }
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

function appendLine(filePath, line) {
  ensureLogDir()
  rotateIfNeeded(filePath)
  try {
    fs.appendFileSync(filePath, line, 'utf8')
  } catch (err) {
    try {
      process.stderr.write(`[logger] failed to write ${filePath}: ${err.message}\n`)
    } catch {
      /* ignore */
    }
  }
}

function formatLine(level, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    pid: process.pid,
    msg: String(message),
  }
  if (meta !== undefined) entry.meta = safeSerialize(meta)
  return `${JSON.stringify(entry)}\n`
}

function write(level, message, meta, { crash = false, client = false } = {}) {
  const line = formatLine(level, message, meta)
  appendLine(SERVER_LOG, line)
  if (crash) appendLine(CRASH_LOG, line)
  if (client) appendLine(CLIENT_LOG, line)

  const prefix = `[${level}]`
  if (level === 'error' || level === 'fatal') {
    console.error(prefix, message, meta !== undefined ? meta : '')
  } else if (level === 'warn') {
    console.warn(prefix, message, meta !== undefined ? meta : '')
  } else {
    console.log(prefix, message, meta !== undefined ? meta : '')
  }
}

const logger = {
  dir: LOG_DIR,
  files: { server: SERVER_LOG, crash: CRASH_LOG, client: CLIENT_LOG },

  info(message, meta) {
    write('info', message, meta)
  },
  warn(message, meta) {
    write('warn', message, meta)
  },
  error(message, meta) {
    write('error', message, meta)
  },
  fatal(message, meta) {
    write('fatal', message, meta, { crash: true })
  },
  client(message, meta) {
    write('client', message, meta, { client: true })
  },

  /** Install process-wide crash / exit handlers (call once at boot). */
  installProcessHandlers() {
    if (global.__multichatLoggerHandlersInstalled) return
    global.__multichatLoggerHandlersInstalled = true

    process.on('uncaughtException', (err) => {
      write('fatal', 'uncaughtException', err, { crash: true })
      // Give the sync write a tick, then exit so nodemon can restart cleanly
      setTimeout(() => process.exit(1), 50)
    })

    process.on('unhandledRejection', (reason) => {
      write('fatal', 'unhandledRejection', reason, { crash: true })
    })

    process.on('warning', (warning) => {
      write('warn', 'process.warning', warning)
    })

    process.on('exit', (code) => {
      // sync only — async won't flush on exit
      try {
        ensureLogDir()
        fs.appendFileSync(
          SERVER_LOG,
          formatLine('info', 'process.exit', { code }),
          'utf8'
        )
      } catch {
        /* ignore */
      }
    })

    write('info', 'logger.handlers.installed', {
      logDir: LOG_DIR,
      node: process.version,
      cwd: process.cwd(),
    })
  },

  /** Tail the last N lines from a log file (for /api/logs/recent). */
  readRecent(which = 'server', lines = 80) {
    ensureLogDir()
    const map = {
      server: SERVER_LOG,
      crash: CRASH_LOG,
      client: CLIENT_LOG,
    }
    const filePath = map[which] || SERVER_LOG
    if (!fs.existsSync(filePath)) {
      return { file: filePath, lines: [], note: 'Log file not created yet' }
    }
    const raw = fs.readFileSync(filePath, 'utf8')
    const all = raw.split(/\r?\n/).filter(Boolean)
    const slice = all.slice(-Math.max(1, Math.min(lines, 500)))
    return {
      file: filePath,
      count: slice.length,
      totalLines: all.length,
      lines: slice.map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return { raw: line }
        }
      }),
    }
  },
}

ensureLogDir()

module.exports = logger
