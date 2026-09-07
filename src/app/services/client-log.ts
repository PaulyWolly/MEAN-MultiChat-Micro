// @ts-nocheck
/**
 * Browser → server diagnostic log (survives refresh; view via /api/logs/recent?source=client).
 * Fire-and-forget — never blocks UI.
 */
import { environment } from "../../environments/environment"

const API_BASE = String(environment.apiBase || "").replace(/\/$/, "")

export function clientLog(message, detail = {}, level = "info") {
  const payload = {
    message: String(message),
    level,
    source: detail.source || "react",
    detail,
    href: typeof window !== "undefined" ? window.location.href : undefined,
  }

  const prefix = `[client:${level}]`
  if (level === "error" || level === "fatal") {
    console.error(prefix, message, detail)
  } else if (level === "warn") {
    console.warn(prefix, message, detail)
  } else {
    console.log(prefix, message, detail)
  }

  try {
    const body = JSON.stringify(payload)
    // prefer keepalive beacon so logs survive navigation / unload
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" })
      navigator.sendBeacon(`${API_BASE}/api/logs/client`, blob)
      return
    }
    void fetch(`${API_BASE}/api/logs/client`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      /* ignore — server may be down; that's why we also console.log */
    })
  } catch {
    /* ignore */
  }
}

export function clientError(message, detail = {}) {
  clientLog(message, detail, "error")
}

export function clientWarn(message, detail = {}) {
  clientLog(message, detail, "warn")
}
