/**
 * Keep-alive HTTPS agent with a DNS cache for outbound API calls.
 *
 * Node's dns.lookup on this stack can stall for ~11 seconds once the OS cache
 * entry for a host expires — the same flaky-resolver behaviour that
 * mongoDnsFallback.js works around for Atlas. On a text-to-speech call that
 * stall lands directly in the user's face as silence before the reply is read.
 *
 * Two mitigations, which work together:
 *   1. Cache resolved addresses in-process so a slow resolver is consulted at
 *      most once per TTL rather than once per request.
 *   2. Refresh entries on a background timer, so the occasional slow lookup is
 *      paid by the timer instead of by a waiting user.
 *
 * A stale entry is preferred over an error: if the resolver fails, reusing the
 * last known address is far more likely to work than failing the request.
 */

const dns = require('dns')
const https = require('https')

const DNS_TTL_MS = 5 * 60 * 1000
// Comfortably shorter than the TTL so entries are replaced before they lapse.
const DNS_REFRESH_MS = 4 * 60 * 1000

const cache = new Map()
const warming = new Set()

function respond(callback, entry, wantsAll) {
  if (wantsAll) return callback(null, entry.all)
  return callback(null, entry.address, entry.family)
}

/** Drop-in replacement for dns.lookup that serves from cache when it can. */
function cachedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  const wantsAll = Boolean(options && options.all)
  const cached = cache.get(hostname)

  if (cached && cached.expires > Date.now()) {
    return process.nextTick(() => respond(callback, cached, wantsAll))
  }

  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err || !addresses || !addresses.length) {
      if (cached) return respond(callback, cached, wantsAll)
      return callback(err || new Error(`No addresses for ${hostname}`))
    }

    const entry = {
      address: addresses[0].address,
      family: addresses[0].family,
      all: addresses,
      expires: Date.now() + DNS_TTL_MS,
    }
    cache.set(hostname, entry)
    respond(callback, entry, wantsAll)
  })
}

/**
 * Resolve a host now and keep refreshing it in the background.
 * Safe to call more than once per host.
 */
function keepHostWarm(hostname) {
  if (!hostname || warming.has(hostname)) return
  warming.add(hostname)

  const refresh = () => {
    const started = Date.now()
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err || !addresses || !addresses.length) return
      cache.set(hostname, {
        address: addresses[0].address,
        family: addresses[0].family,
        all: addresses,
        expires: Date.now() + DNS_TTL_MS,
      })
      const took = Date.now() - started
      if (took > 2000) {
        console.warn(`[dns] slow lookup for ${hostname}: ${took}ms (absorbed in background)`)
      }
    })
  }

  refresh()
  // unref so a warm-up timer never holds the process open.
  setInterval(refresh, DNS_REFRESH_MS).unref()
}

/**
 * Shared agent for upstream HTTPS calls. Keep-alive avoids repeating the TLS
 * handshake, and the cached lookup avoids repeating DNS.
 */
const upstreamHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 25,
  lookup: cachedLookup,
})

module.exports = { upstreamHttpsAgent, cachedLookup, keepHostWarm }
