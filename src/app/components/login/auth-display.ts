// @ts-nocheck
/**
 * Login method label bits for Account / Profile UI.
 * @param {{ email?: string, role?: string, authProvider?: string|null }|null} user
 */
export function getLoginMethodParts(user) {
  if (!user?.email) {
    return { prefix: "", email: "", role: "", viaSocial: false }
  }
  const role = user.role ? ` (${user.role})` : ""
  if (user.authProvider === "google" || user.authProvider === "auth0") {
    return {
      prefix: "Logged in through Google/Auth0 as ",
      email: user.email,
      role,
      viaSocial: true,
    }
  }
  return {
    prefix: "Logged in through JWT as ",
    email: user.email,
    role,
    viaSocial: false,
  }
}

/** Plain-text version (toasts, titles). */
export function formatLoginMethodLine(user) {
  const { prefix, email, role } = getLoginMethodParts(user)
  if (!email) return ""
  return `${prefix}${email}${role}`
}
