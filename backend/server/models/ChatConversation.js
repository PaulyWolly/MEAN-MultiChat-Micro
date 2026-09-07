/*
  CHATCONVERSATION.JS
  AppName: MERN-MultiChat
  Per-account chat threads (not personal-info "conversation_history").
*/

const mongoose = require('mongoose')

const chatConversationSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    title: { type: String, default: 'Conversation' },
    preview: { type: String, default: '' },
    messageCount: { type: Number, default: 0 },
    messages: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  {
    collection: 'chat_conversations',
    timestamps: { createdAt: true, updatedAt: true },
  }
)

chatConversationSchema.index({ userId: 1, updatedAt: -1 })

module.exports = mongoose.model('ChatConversation', chatConversationSchema)
