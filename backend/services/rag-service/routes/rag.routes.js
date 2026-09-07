/**
 * RAG routes — upload PDF/text, chunk + embed into MongoDB, ask questions.
 */
const express = require('express')
const multer = require('multer')
const path = require('path')
const OpenAI = require('openai')
const pdfParse = require('pdf-parse')
const RagDocument = require('../models/RagDocument')
const RagChunk = require('../models/RagChunk')
const { getAiLimits } = require('../lib/aiLimits')

const router = express.Router()

// multer needs a fixed byte ceiling when the instance is built, so the upload
// cap is resolved once at boot rather than per request.
const RAG_LIMITS = getAiLimits().rag
const MAX_BYTES = RAG_LIMITS.maxUploadBytes
const CHUNK_SIZE = 1000
const CHUNK_OVERLAP = 150
const TOP_K = 5
const CHAT_MODEL = process.env.OPENAI_RAG_CHAT_MODEL || 'gpt-4o-mini'

/**
 * Default to widely available models. Do NOT auto-try text-embedding-3-large —
 * many projects list it but still return 403, which broke follow-up "ask" calls.
 * Override with OPENAI_EMBEDDING_MODEL in server/.env if needed.
 */
const EMBED_MODEL_CANDIDATES = [
  process.env.OPENAI_EMBEDDING_MODEL,
  'text-embedding-ada-002',
  'text-embedding-3-small',
].filter(Boolean)

let resolvedEmbedModel = null

const ALLOWED_EXT = new Set(['.pdf', '.txt', '.md'])
const ALLOWED_MIME = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/octet-stream',
])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase()
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error('Only PDF, .txt, and .md files are allowed'))
    }
    if (file.mimetype && !ALLOWED_MIME.has(file.mimetype) && !file.mimetype.startsWith('text/')) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`))
    }
    cb(null, true)
  },
})

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set on the server')
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const cleaned = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+\n/g, '\n')
    .trim()
  if (!cleaned) return []

  const chunks = []
  let start = 0
  while (start < cleaned.length) {
    const end = Math.min(start + size, cleaned.length)
    const slice = cleaned.slice(start, end).trim()
    if (slice) chunks.push(slice)
    if (end >= cleaned.length) break
    start = Math.max(0, end - overlap)
  }
  return chunks
}

function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return -1
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return -1
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function isModelAccessError(err) {
  const status = err?.status || err?.response?.status
  const msg = String(err?.message || err || '')
  return (
    status === 403 ||
    status === 404 ||
    /does not have access to model|model_not_found|not found/i.test(msg)
  )
}

/**
 * Embed texts. Prefer preferredModel (from the indexed doc) so ask matches upload.
 * If a cached/preferred model 403s, clear it and try the other candidates.
 * Skip text-embedding-3-large unless OPENAI_EMBEDDING_MODEL explicitly sets it —
 * OpenAI often shows it under Limits while still returning 403 for the project key.
 */
async function embedTexts(openai, texts, preferredModel = '') {
  const allowLarge =
    process.env.OPENAI_EMBEDDING_MODEL === 'text-embedding-3-large'
  const input = texts.map((t) => t.slice(0, 8000))
  const models = [
    preferredModel,
    resolvedEmbedModel,
    ...EMBED_MODEL_CANDIDATES,
  ]
    .filter(Boolean)
    .filter((model) => allowLarge || model !== 'text-embedding-3-large')
  const tried = new Set()

  let lastError
  for (const model of models) {
    if (tried.has(model)) continue
    tried.add(model)
    try {
      const response = await openai.embeddings.create({ model, input })
      resolvedEmbedModel = model
      console.log(`[rag] using embedding model: ${model}`)
      return {
        model,
        embeddings: response.data
          .sort((a, b) => a.index - b.index)
          .map((row) => row.embedding),
      }
    } catch (err) {
      lastError = err
      if (isModelAccessError(err)) {
        console.warn(`[rag] embedding model unavailable: ${model} — ${err.message}`)
        if (resolvedEmbedModel === model) resolvedEmbedModel = null
        continue
      }
      throw err
    }
  }

  throw new Error(
    lastError?.message ||
      'No OpenAI embedding model available for this API key/project. ' +
        'Enable text-embedding-3-small or text-embedding-ada-002 in the OpenAI project, ' +
        'or set OPENAI_EMBEDDING_MODEL in server/.env'
  )
}

async function extractText(file) {
  const ext = path.extname(file.originalname || '').toLowerCase()
  if (ext === '.pdf' || file.mimetype === 'application/pdf') {
    const parsed = await pdfParse(file.buffer)
    return String(parsed.text || '').trim()
  }
  return file.buffer.toString('utf8').trim()
}

function serializeDoc(doc) {
  return {
    id: String(doc._id),
    filename: doc.filename,
    mimeType: doc.mimeType,
    charCount: doc.charCount,
    chunkCount: doc.chunkCount,
    embeddingModel: doc.embeddingModel || '',
    status: doc.status,
    error: doc.error || '',
    createdAt: doc.createdAt,
  }
}

/** POST /api/rag/upload — multipart field "file" + dataKey */
router.post('/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `File is too large (max ${RAG_LIMITS.maxUploadMb}MB)`
          : err.message || 'Upload failed'
      return res.status(400).json({ success: false, error: message })
    }

    let doc = null
    try {
      const dataKey = String(req.body.dataKey || '').trim()
      if (!dataKey) {
        return res.status(400).json({ success: false, error: 'dataKey is required' })
      }
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' })
      }

      // Storage and embedding cost scale with the library size, so cap how many
      // documents a single data key can keep at once.
      const existingDocs = await RagDocument.countDocuments({ dataKey })
      if (existingDocs >= RAG_LIMITS.maxDocs) {
        return res.status(429).json({
          success: false,
          error: `Document limit reached (${RAG_LIMITS.maxDocs}). Delete a document before uploading another.`,
        })
      }

      doc = await RagDocument.create({
        dataKey,
        filename: req.file.originalname,
        mimeType: req.file.mimetype || '',
        status: 'processing',
      })

      const text = await extractText(req.file)
      if (!text) {
        doc.status = 'error'
        doc.error = 'No readable text found in that file'
        await doc.save()
        return res.status(400).json({
          success: false,
          error: doc.error,
          document: serializeDoc(doc),
        })
      }

      const pieces = chunkText(text)
      if (!pieces.length) {
        doc.status = 'error'
        doc.error = 'Could not chunk document text'
        await doc.save()
        return res.status(400).json({
          success: false,
          error: doc.error,
          document: serializeDoc(doc),
        })
      }

      const openai = getOpenAI()
      // Batch embeddings (API allows many inputs per call)
      const BATCH = 64
      const embeddings = []
      let usedModel = ''
      for (let i = 0; i < pieces.length; i += BATCH) {
        const batch = pieces.slice(i, i + BATCH)
        const result = await embedTexts(openai, batch)
        usedModel = result.model
        embeddings.push(...result.embeddings)
      }

      const chunkDocs = pieces.map((piece, index) => ({
        documentId: doc._id,
        dataKey,
        index,
        text: piece,
        embedding: embeddings[index],
      }))
      await RagChunk.insertMany(chunkDocs)

      doc.charCount = text.length
      doc.chunkCount = pieces.length
      doc.embeddingModel = usedModel
      doc.status = 'ready'
      doc.error = ''
      await doc.save()

      return res.json({ success: true, document: serializeDoc(doc) })
    } catch (error) {
      console.error('[rag] upload failed:', error)
      if (doc) {
        try {
          doc.status = 'error'
          doc.error = error.message || 'Processing failed'
          await doc.save()
        } catch {
          /* ignore */
        }
      }
      return res.status(500).json({
        success: false,
        error: error.message || 'Upload failed',
        document: doc ? serializeDoc(doc) : undefined,
      })
    }
  })
})

/** GET /api/rag/documents?dataKey= */
router.get('/documents', async (req, res) => {
  try {
    const dataKey = String(req.query.dataKey || '').trim()
    if (!dataKey) {
      return res.status(400).json({ success: false, error: 'dataKey is required' })
    }
    const docs = await RagDocument.find({ dataKey })
      .sort({ createdAt: -1 })
      .lean()
    return res.json({
      success: true,
      documents: docs.map(serializeDoc),
    })
  } catch (error) {
    console.error('[rag] list failed:', error)
    return res.status(500).json({ success: false, error: error.message || 'List failed' })
  }
})

/** DELETE /api/rag/documents/:id?dataKey= */
router.delete('/documents/:id', async (req, res) => {
  try {
    const dataKey = String(req.query.dataKey || req.body?.dataKey || '').trim()
    if (!dataKey) {
      return res.status(400).json({ success: false, error: 'dataKey is required' })
    }
    const doc = await RagDocument.findOne({ _id: req.params.id, dataKey })
    if (!doc) {
      return res.status(404).json({ success: false, error: 'Document not found' })
    }
    await RagChunk.deleteMany({ documentId: doc._id, dataKey })
    await RagDocument.deleteOne({ _id: doc._id })
    return res.json({ success: true })
  } catch (error) {
    console.error('[rag] delete failed:', error)
    return res.status(500).json({ success: false, error: error.message || 'Delete failed' })
  }
})

/** POST /api/rag/ask — { dataKey, question, documentId?, documentIds? } */
router.post('/ask', async (req, res) => {
  try {
    const dataKey = String(req.body.dataKey || '').trim()
    const question = String(req.body.question || '').trim()
    const rawIds = Array.isArray(req.body.documentIds)
      ? req.body.documentIds
      : req.body.documentId
        ? [req.body.documentId]
        : []
    const documentIds = [
      ...new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean)),
    ]

    if (!dataKey) {
      return res.status(400).json({ success: false, error: 'dataKey is required' })
    }
    if (!question) {
      return res.status(400).json({ success: false, error: 'question is required' })
    }
    if (question.length > RAG_LIMITS.maxQuestionChars) {
      return res.status(400).json({
        success: false,
        error: `Question is too long (max ${RAG_LIMITS.maxQuestionChars} characters)`,
      })
    }

    const filter = { dataKey }
    let preferredEmbedModel = ''
    if (documentIds.length) {
      const selectedDocs = await RagDocument.find({
        _id: { $in: documentIds },
        dataKey,
        status: 'ready',
      })
        .select('embeddingModel')
        .lean()
      if (!selectedDocs.length) {
        return res.status(404).json({
          success: false,
          error: 'Selected document not found or not ready',
        })
      }
      filter.documentId = { $in: selectedDocs.map((d) => d._id) }
      preferredEmbedModel =
        selectedDocs.find((d) => d.embeddingModel)?.embeddingModel || ''
    } else {
      const readyDocs = await RagDocument.find({ dataKey, status: 'ready' })
        .select('embeddingModel')
        .lean()
      if (!readyDocs.length) {
        return res.status(400).json({
          success: false,
          error: 'Upload a document first, then ask a question',
        })
      }
      preferredEmbedModel = readyDocs.find((d) => d.embeddingModel)?.embeddingModel || ''
    }

    const chunks = await RagChunk.find(filter).lean()
    if (!chunks.length) {
      return res.status(400).json({
        success: false,
        error: 'No indexed chunks found for that selection',
      })
    }

    const openai = getOpenAI()
    const { embeddings: queryEmbeddings } = await embedTexts(
      openai,
      [question],
      preferredEmbedModel
    )
    const queryEmbedding = queryEmbeddings[0]

    const ranked = chunks
      .map((chunk) => ({
        ...chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K)

    const docIds = [...new Set(ranked.map((c) => String(c.documentId)))]
    const docs = await RagDocument.find({ _id: { $in: docIds } }).lean()
    const nameById = Object.fromEntries(
      docs.map((d) => [String(d._id), d.filename])
    )

    const contextBlocks = ranked.map((c, i) => {
      const name = nameById[String(c.documentId)] || 'document'
      return `[Source ${i + 1}: ${name}]\n${c.text}`
    })
    const context = contextBlocks.join('\n\n')

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You answer questions using ONLY the provided document context. ' +
            'If the answer is not in the context, say you do not know based on the uploaded documents. ' +
            'Be concise and cite source numbers when helpful (e.g. Source 1).',
        },
        {
          role: 'user',
          content: `Context:\n${context}\n\nQuestion: ${question}`,
        },
      ],
    })

    const answer =
      completion.choices?.[0]?.message?.content?.trim() ||
      'No answer generated.'

    const sources = ranked.map((c, i) => ({
      filename: nameById[String(c.documentId)] || 'document',
      snippet: c.text.slice(0, 280) + (c.text.length > 280 ? '…' : ''),
      score: Number(c.score.toFixed(4)),
      label: `Source ${i + 1}`,
    }))

    return res.json({ success: true, answer, sources })
  } catch (error) {
    console.error('[rag] ask failed:', error)
    return res.status(500).json({ success: false, error: error.message || 'Ask failed' })
  }
})

module.exports = router
