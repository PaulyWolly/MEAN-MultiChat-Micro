// @ts-nocheck
/**
 * Serialize chat messages for MongoDB (no huge data-URL attachments).
 */

export function titleFromMessages(messages) {
  const firstUser = (messages || []).find(
    (m) => m.role === "user" && String(m.content || "").trim()
  )
  const t = String(firstUser?.content || "Conversation")
    .replace(/\s+/g, " ")
    .trim()
  if (!t) return "Conversation"
  return t.length > 72 ? `${t.slice(0, 72)}…` : t
}

export function serializeChatMessages(messages) {
  return (messages || []).map((msg) => {
    const images = Array.isArray(msg.images)
      ? msg.images.slice(0, 12).map((img) => ({
          url: img.url || "",
          thumb: img.thumb || "",
          originalUrl: img.originalUrl || "",
          title: img.title || "Image",
        }))
      : undefined
    const out = {
      id: msg.id,
      role: msg.role === "assistant" ? "assistant" : "user",
      content: String(msg.content || ""),
      usedWebSearch: Boolean(msg.usedWebSearch),
    }
    if (msg.imageName) out.imageName = msg.imageName
    if (images?.length) out.images = images
    if (msg.imagesError) out.imagesError = msg.imagesError
    if (msg.imageSubject) out.imageSubject = msg.imageSubject
    if (msg.imagesNextStart != null) out.imagesNextStart = msg.imagesNextStart
    if (msg.imagesExhausted) out.imagesExhausted = true
    return out
  })
}

export function hasPersistableChat(messages) {
  return (messages || []).some(
    (m) => m.role === "user" && String(m.content || "").trim()
  )
}
