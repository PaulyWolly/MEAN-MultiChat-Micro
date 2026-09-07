/*
  Chat conversation persistence — signed-in accounts only (req.scopeKey).
*/
const express = require('express')
const mongoose = require('mongoose')
const ChatConversation = require('../models/ChatConversation')
const { requireDataScope } = require('../middleware/auth')

const router = express.Router()
router.use(requireDataScope)

const MAX_MESSAGES = 200
const MAX_CONTENT = 20000

function isValidId(id) {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id)
}

function sanitizeImage(img) {
  if (!img || typeof img !== 'object') return null
  const url = String(img.url || '').slice(0, 2000)
  const thumb = String(img.thumb || '').slice(0, 2000)
  const originalUrl = String(img.originalUrl || '').slice(0, 2000)
  if (!url && !thumb) return null
  return {
    url,
    thumb,
    originalUrl,
    title: String(img.title || 'Image').slice(0, 200),
  }
}

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, MAX_MESSAGES).map((msg) => {
    const role = msg?.role === 'assistant' ? 'assistant' : 'user'
    const images = Array.isArray(msg?.images)
      ? msg.images.map(sanitizeImage).filter(Boolean).slice(0, 12)
      : undefined
    const out = {
      id: String(msg?.id || '').slice(0, 80),
      role,
      content: String(msg?.content || '').slice(0, MAX_CONTENT),
      usedWebSearch: Boolean(msg?.usedWebSearch),
    }
    if (msg?.imageName) out.imageName = String(msg.imageName).slice(0, 200)
    if (images?.length) out.images = images
    if (msg?.imagesError) out.imagesError = String(msg.imagesError).slice(0, 300)
    if (msg?.imageSubject) out.imageSubject = String(msg.imageSubject).slice(0, 200)
    if (msg?.imagesNextStart != null) out.imagesNextStart = Number(msg.imagesNextStart) || 0
    if (msg?.imagesExhausted) out.imagesExhausted = true
    return out
  })
}

function previewFromMessages(messages) {
  const user = messages.find((m) => m.role === 'user' && m.content)
  const text = String(user?.content || messages[0]?.content || '').replace(/\s+/g, ' ').trim()
  return text.slice(0, 140)
}

function toSummary(doc) {
  return {
    _id: doc._id,
    title: doc.title,
    preview: doc.preview,
    messageCount: doc.messageCount,
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
  }
}

router.get('/', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json({ success: true, conversations: [] })
    }
    const rows = await ChatConversation.find({ userId: req.scopeKey })
      .select('title preview messageCount updatedAt createdAt')
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean()
    res.json({ success: true, conversations: rows })
  } catch (error) {
    console.error('[chat-history] list', error)
    res.status(500).json({ success: false, message: error.message || 'Failed to list conversations' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid conversation id' })
    }
    const doc = await ChatConversation.findOne({
      _id: req.params.id,
      userId: req.scopeKey,
    }).lean()
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Conversation not found' })
    }
    res.json({ success: true, conversation: doc })
  } catch (error) {
    console.error('[chat-history] get', error)
    res.status(500).json({ success: false, message: error.message || 'Failed to load conversation' })
  }
})

router.post('/', async (req, res) => {
  try {
    const messages = sanitizeMessages(req.body?.messages)
    if (!messages.length) {
      return res.status(400).json({ success: false, message: 'messages are required' })
    }
    const title = String(req.body?.title || 'Conversation')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'Conversation'
    const payload = {
      title,
      messages,
      messageCount: messages.length,
      preview: previewFromMessages(messages),
    }
    const id = req.body?.id
    if (isValidId(id)) {
      const updated = await ChatConversation.findOneAndUpdate(
        { _id: id, userId: req.scopeKey },
        { $set: payload },
        { new: true }
      )
      if (updated) {
        return res.json({ success: true, conversation: updated })
      }
    }
    const created = await ChatConversation.create({
      userId: req.scopeKey,
      ...payload,
    })
    res.json({ success: true, conversation: created })
  } catch (error) {
    console.error('[chat-history] save', error)
    res.status(500).json({ success: false, message: error.message || 'Failed to save conversation' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid conversation id' })
    }
    const result = await ChatConversation.deleteOne({
      _id: req.params.id,
      userId: req.scopeKey,
    })
    if (!result.deletedCount) {
      return res.status(404).json({ success: false, message: 'Conversation not found' })
    }
    res.json({ success: true })
  } catch (error) {
    console.error('[chat-history] delete', error)
    res.status(500).json({ success: false, message: error.message || 'Failed to delete conversation' })
  }
})

module.exports = router
