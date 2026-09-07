// @ts-nocheck
/**
 * YouTube channel helpers for card links / in-app player.
 */

export function youtubeChannelHref({ channelId, channelTitle, channel } = {}) {
  const id = String(channelId || "").trim()
  if (id) return `https://www.youtube.com/channel/${encodeURIComponent(id)}`

  const name = String(channelTitle || channel || "").trim()
  if (!name) return ""

  return `https://www.youtube.com/results?search_query=${encodeURIComponent(
    `${name} channel`
  )}`
}

/**
 * Channel uploads playlist id: UC… → UU…
 * Used by the in-app embed player so channel clicks stay in Multichat.
 */
export function youtubeUploadsPlaylistId(channelId) {
  const id = String(channelId || "").trim()
  if (!id) return ""
  if (id.startsWith("UU")) return id
  if (id.startsWith("UC") && id.length > 2) return `UU${id.slice(2)}`
  return ""
}

export function youtubeChannelEmbedSrc(channelId) {
  const list = youtubeUploadsPlaylistId(channelId)
  if (!list) return ""
  return `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(
    list
  )}&autoplay=1&rel=0&modestbranding=1&playsinline=1`
}
