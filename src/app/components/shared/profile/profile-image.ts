// @ts-nocheck
/**
 * Resize an image File to a small JPEG data URL for Mongo avatar storage.
 */
export function fileToAvatarDataUrl(file, { maxSize = 256, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type?.startsWith("image/")) {
      reject(new Error("Please choose an image file."))
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      reject(new Error("Image must be under 8 MB."))
      return
    }

    const reader = new FileReader()
    reader.onerror = () => reject(new Error("Could not read that image."))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error("Could not decode that image."))
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement("canvas")
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext("2d")
        if (!ctx) {
          reject(new Error("Canvas unavailable."))
          return
        }
        ctx.drawImage(img, 0, 0, w, h)
        try {
          resolve(canvas.toDataURL("image/jpeg", quality))
        } catch (err) {
          reject(err)
        }
      }
      img.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

export function initialsFromProfile(profile = {}, user = null) {
  const name = String(profile.name || "").trim()
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
    }
    return name.slice(0, 2).toUpperCase()
  }
  const email = String(user?.email || "").trim()
  if (email) return email.slice(0, 2).toUpperCase()
  return "ME"
}

/** First name from profile, or email local-part fallback. */
export function firstNameFromProfile(profile = {}, user = null) {
  const name = String(profile?.name || "").trim()
  if (name) {
    const first = name.split(/\s+/).filter(Boolean)[0]
    if (first) return first
  }
  const email = String(user?.email || "").trim()
  if (email.includes("@")) {
    const local = email.split("@")[0].trim()
    if (local) return local.charAt(0).toUpperCase() + local.slice(1)
  }
  return ""
}
