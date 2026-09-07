/**
 * Remove cached YouTube videos whose thumbnails are unreachable (private/deleted).
 * Usage:
 *   node scripts/cleanupInaccessibleYouTubeThumbs.js
 *   node scripts/cleanupInaccessibleYouTubeThumbs.js "americas got talent"
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const mongoose = require('mongoose')
const https = require('https')
const http = require('http')

function headOk(url) {
  return new Promise((resolve) => {
    if (!url || typeof url !== 'string') return resolve(false)
    const lib = url.startsWith('https') ? https : http
    const req = lib.request(url, { method: 'HEAD', timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        headOk(res.headers.location).then(resolve)
        return
      }
      resolve(res.statusCode >= 200 && res.statusCode < 400)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

async function thumbReachable(video) {
  const id = video?.id
  const urls = [
    video?.thumbnail,
    id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null,
    id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null,
  ].filter(Boolean)
  for (const u of urls) {
    if (await headOk(u)) return true
  }
  return false
}

async function cleanupYouTubeSearchDocs(filter = {}) {
  const col = mongoose.connection.db.collection('youtube_searches')
  const docs = await col.find(filter).toArray()
  let removedTotal = 0
  let updatedDocs = 0

  for (const doc of docs) {
    let changed = false
    const pages = Array.isArray(doc.videoResults) ? doc.videoResults : []
    for (const page of pages) {
      const before = (page.videos || []).length
      const kept = []
      for (const v of page.videos || []) {
        if (await thumbReachable(v)) kept.push(v)
        else {
          removedTotal++
          console.log(
            '  drop',
            doc.query,
            `p${page.page}`,
            v.id,
            String(v.title || '').slice(0, 40)
          )
        }
      }
      if (kept.length !== before) {
        page.videos = kept
        page.totalResults = kept.length
        changed = true
      }
    }
    if (changed) {
      updatedDocs++
      const videoCount = pages.reduce((n, p) => n + (p.videos || []).length, 0)
      await col.updateOne(
        { _id: doc._id },
        { $set: { videoResults: pages, videoCount, totalPages: pages.length } }
      )
      console.log(
        'Updated',
        String(doc._id),
        doc.displayName || doc.query,
        'videos now',
        videoCount
      )
    }
  }

  return { matched: docs.length, updatedDocs, removedTotal }
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) throw new Error('No MONGODB_URI')
  const q = process.argv.slice(2).join(' ').trim()
  const filter = q
    ? {
        $or: [
          { query: new RegExp(q.replace(/\s+/g, '.*'), 'i') },
          { displayName: new RegExp(q.replace(/\s+/g, '\\s*'), 'i') },
        ],
      }
    : {}

  console.log('Connecting… filter=', q || '(all searches)')
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 })
  const result = await cleanupYouTubeSearchDocs(filter)
  console.log(JSON.stringify(result, null, 2))
  await mongoose.disconnect()
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error(e)
    try {
      await mongoose.disconnect()
    } catch {
      /* ignore */
    }
    process.exit(1)
  })
}

module.exports = { cleanupYouTubeSearchDocs, thumbReachable }
