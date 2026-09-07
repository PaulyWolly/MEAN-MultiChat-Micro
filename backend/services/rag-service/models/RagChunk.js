const mongoose = require('mongoose')

const ragChunkSchema = new mongoose.Schema(
  {
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RagDocument',
      required: true,
      index: true,
    },
    dataKey: { type: String, required: true, index: true },
    index: { type: Number, required: true },
    text: { type: String, required: true },
    embedding: { type: [Number], required: true },
  },
  {
    collection: 'rag_chunks',
    timestamps: { createdAt: true, updatedAt: false },
  }
)

ragChunkSchema.index({ dataKey: 1, documentId: 1 })

module.exports = mongoose.model('RagChunk', ragChunkSchema)
