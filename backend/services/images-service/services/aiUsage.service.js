const AiUsage = require('../models/AiUsage')
const { getAiLimits } = require('../lib/aiLimits')

/** UTC calendar day, 'YYYY-MM-DD'. Quotas reset at 00:00 UTC. */
function currentDay(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

/** Milliseconds until the next UTC midnight, for "resets in" messaging. */
function msUntilReset(now = new Date()) {
  const next = new Date(now)
  next.setUTCHours(24, 0, 0, 0)
  return next.getTime() - now.getTime()
}

function normalizeUserId(user) {
  const id = user?.id ?? user?._id
  return id ? String(id) : ''
}

/**
 * Read current standing without changing it. Used by GET /api/ai/status.
 * @returns {Promise<{limit:number,used:number,remaining:number,day:string,resetsInMs:number}>}
 */
async function getImageUsage(user) {
  const { dailyLimit } = getAiLimits().image
  const day = currentDay()
  const userId = normalizeUserId(user)

  let used = 0
  if (userId) {
    const doc = await AiUsage.findOne({ userId, day, feature: 'image' }).lean()
    used = doc?.count || 0
  }

  return {
    limit: dailyLimit,
    used,
    remaining: Math.max(0, dailyLimit - used),
    day,
    resetsInMs: msUntilReset(),
  }
}

/**
 * Atomically reserve one image generation before calling the paid API.
 *
 * The increment and the cap check are a single findOneAndUpdate, so two
 * concurrent requests cannot both slip past the last remaining slot. When the
 * cap is already reached the filter misses, the upsert collides with the unique
 * index, and the duplicate key error tells us the user is out of quota.
 *
 * @returns {Promise<{ok:true,used:number,remaining:number,limit:number}
 *   | {ok:false,reason:'anonymous'|'disabled'|'limit',limit:number,used:number,remaining:number,resetsInMs:number}>}
 */
async function claimImageGeneration(user) {
  const { dailyLimit } = getAiLimits().image
  const day = currentDay()
  const userId = normalizeUserId(user)

  if (!userId) {
    return { ok: false, reason: 'anonymous', limit: dailyLimit, used: 0, remaining: 0, resetsInMs: msUntilReset() }
  }
  if (dailyLimit <= 0) {
    return { ok: false, reason: 'disabled', limit: 0, used: 0, remaining: 0, resetsInMs: msUntilReset() }
  }

  try {
    const doc = await AiUsage.findOneAndUpdate(
      { userId, day, feature: 'image', count: { $lt: dailyLimit } },
      { $inc: { count: 1 }, $setOnInsert: { userId, day, feature: 'image' } },
      { new: true, upsert: true }
    )
    return {
      ok: true,
      used: doc.count,
      remaining: Math.max(0, dailyLimit - doc.count),
      limit: dailyLimit,
    }
  } catch (err) {
    if (err?.code === 11000) {
      const usage = await getImageUsage(user)
      return { ok: false, reason: 'limit', ...usage }
    }
    throw err
  }
}

/**
 * Hand a claimed slot back when the paid call failed, so a provider outage does
 * not silently eat someone's daily allowance. Never drops the counter below 0.
 */
async function releaseImageGeneration(user) {
  const userId = normalizeUserId(user)
  if (!userId) return

  try {
    await AiUsage.updateOne(
      { userId, day: currentDay(), feature: 'image', count: { $gt: 0 } },
      { $inc: { count: -1 } }
    )
  } catch (err) {
    // A failed refund must not mask the original error the caller is handling.
    console.error('[aiUsage] release failed:', err?.message || err)
  }
}

module.exports = {
  currentDay,
  msUntilReset,
  getImageUsage,
  claimImageGeneration,
  releaseImageGeneration,
}
