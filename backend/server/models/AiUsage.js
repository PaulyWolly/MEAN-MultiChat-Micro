const mongoose = require('mongoose')

/**
 * One counter row per user, per UTC day, per metered feature.
 *
 * Keyed on userId rather than dataKey: dataKey lives in browser storage, so a
 * user could clear it and mint themselves a fresh allowance. A signed-in user
 * id cannot be reset from the client.
 */
const aiUsageSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    // UTC calendar day, 'YYYY-MM-DD'
    day: { type: String, required: true },
    feature: { type: String, required: true, enum: ['image'] },
    count: { type: Number, default: 0, min: 0 },
  },
  {
    collection: 'ai_usage',
    timestamps: { createdAt: true, updatedAt: true },
  }
)

// The claim path relies on this being unique: a claim that would exceed the cap
// fails the filter, falls through to an upsert, and trips a duplicate key error.
aiUsageSchema.index({ userId: 1, day: 1, feature: 1 }, { unique: true })

module.exports = mongoose.model('AiUsage', aiUsageSchema)
