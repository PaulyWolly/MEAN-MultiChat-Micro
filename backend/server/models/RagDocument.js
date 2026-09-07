const mongoose = require('mongoose')

const ragDocumentSchema = new mongoose.Schema(
  {
    dataKey: { type: String, required: true, index: true },
    filename: { type: String, required: true },
    mimeType: { type: String, default: '' },
    charCount: { type: Number, default: 0 },
    chunkCount: { type: Number, default: 0 },
    embeddingModel: { type: String, default: '' },
    status: {
      type: String,
      enum: ['processing', 'ready', 'error'],
      default: 'processing',
    },
    error: { type: String, default: '' },
  },
  {
    collection: 'rag_documents',
    timestamps: { createdAt: true, updatedAt: true },
  }
)

ragDocumentSchema.index({ dataKey: 1, createdAt: -1 })

module.exports = mongoose.model('RagDocument', ragDocumentSchema)
