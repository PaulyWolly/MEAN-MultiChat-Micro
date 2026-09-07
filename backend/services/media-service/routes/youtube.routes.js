/**
 * YouTube API routes — peeled from backend/server/server.js into media-service.
 * Mounted at /api/youtube (history is a separate router).
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const chalk = require('chalk');
const { google } = require('googleapis');
const NodeCache = require('node-cache');
const PageToken = require('../models/PageToken');
const YouTubeSearch = require('../models/YouTubeSearch');
const { requireDataScope } = require('../middleware/auth');

const router = express.Router();

/** Existing single-user Multichat docs live under these keys. */
const LEGACY_DATA_KEY = 'global-persistent-storage-001-v1';
const LEGACY_USER_ALIASES = ['default-user', LEGACY_DATA_KEY];

if (!process.env.GOOGLE_API_KEY) {
  console.error('[media-service] GOOGLE_API_KEY is not set (expected in backend/server/.env)');
  process.exit(1);
}

const youtube = google.youtube({
  version: 'v3',
  auth: process.env.GOOGLE_API_KEY,
});

console.log('[media-service] YouTube API client initialized', {
  keyPresent: !!process.env.GOOGLE_API_KEY,
  keyLength: process.env.GOOGLE_API_KEY?.length || 0,
});


// =====================================================
// HELPERS + LATE ROUTES (cache, quota, search, admin)
// =====================================================
// YouTube API Cache and Optimization System
const youtubeCache = new NodeCache({
    stdTTL: 3600, // 1 hour cache
    checkperiod: 600, // Check for expired keys every 10 minutes
    maxKeys: 1000 // Limit cache size
});

// Quota tracking with persistence
const quotaFilePath = path.join(__dirname, '..', 'quota-tracking.json');

let dailyQuotaUsed = 0;
let googleQuotaExceeded = false;
let googleQuotaExceededAt = null;
let quotaResetTime = new Date();

// Simple approach: Reset at midnight Pacific Time (7 AM UTC)
quotaResetTime.setUTCHours(7, 0, 0, 0);
if (quotaResetTime <= new Date()) {
    quotaResetTime.setDate(quotaResetTime.getDate() + 1);
}

// Load persistent quota data on startup
function loadQuotaData() {
    try {
        if (fs.existsSync(quotaFilePath)) {
            const data = JSON.parse(fs.readFileSync(quotaFilePath, 'utf8'));
            const savedResetTime = new Date(data.resetTime);

            // If the saved reset time hasn't passed yet, restore the usage
            if (savedResetTime > new Date()) {
                dailyQuotaUsed = data.used || 0;
                googleQuotaExceeded = !!data.googleQuotaExceeded;
                googleQuotaExceededAt = data.googleQuotaExceededAt || null;
                quotaResetTime = savedResetTime;
                console.log(`📊 [QUOTA] Restored from file: ${dailyQuotaUsed}/10000 used, googleExceeded=${googleQuotaExceeded}, resets at ${quotaResetTime.toISOString()}`);
            } else {
                console.log(`📊 [QUOTA] Quota file found but expired, starting fresh`);
                saveQuotaData(); // Save current state
            }
        } else {
            console.log(`📊 [QUOTA] No quota file found, starting fresh`);
            saveQuotaData(); // Create initial file
        }
    } catch (error) {
        console.error('📊 [QUOTA] Error loading quota data:', error);
        saveQuotaData(); // Create fresh file on error
    }
}

// Save quota data to file
function saveQuotaData() {
    try {
        const data = {
            used: dailyQuotaUsed,
            googleQuotaExceeded,
            googleQuotaExceededAt,
            resetTime: quotaResetTime.toISOString(),
            lastUpdated: new Date().toISOString()
        };
        fs.writeFileSync(quotaFilePath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('📊 [QUOTA] Error saving quota data:', error);
    }
}

// Load quota data on startup
loadQuotaData();

// Request deduplication - prevent multiple identical requests
const pendingRequests = new Map();

function resetQuotaIfNeeded() {
    const now = new Date();
    if (now >= quotaResetTime) {
        const oldUsage = dailyQuotaUsed;
        dailyQuotaUsed = 0;
        googleQuotaExceeded = false;
        googleQuotaExceededAt = null;
        quotaResetTime.setDate(quotaResetTime.getDate() + 1);
        quotaResetTime.setUTCHours(7, 0, 0, 0); // Ensure it's set to 7 AM UTC
        console.log(`📊 [QUOTA] Daily quota reset: ${oldUsage} → 0. Next reset: ${quotaResetTime.toISOString()}`);
        saveQuotaData(); // Persist the reset
    }
}

function isYouTubeQuotaError(error) {
    const message = (error?.message || String(error)).toLowerCase();
    return (
        message.includes('quota') &&
        (message.includes('exceeded') ||
            message.includes('limit') ||
            message.includes('daily'))
    );
}

function markGoogleQuotaExceeded(source = 'api') {
    if (!googleQuotaExceeded) {
        googleQuotaExceeded = true;
        googleQuotaExceededAt = new Date().toISOString();
        console.log(`🚫 [QUOTA] Google daily quota EXCEEDED (source: ${source})`);
        saveQuotaData();
    }
}

function getEffectiveQuotaUsed() {
    resetQuotaIfNeeded();
    return googleQuotaExceeded ? 10000 : dailyQuotaUsed;
}

function getQuotaStatus() {
    resetQuotaIfNeeded();
    const used = getEffectiveQuotaUsed();
    const total = 10000;
    return {
        used,
        trackedUsed: dailyQuotaUsed,
        remaining: Math.max(0, total - used),
        total,
        percentage: Math.round((used / total) * 100),
        resetTime: quotaResetTime.toISOString(),
        timeUntilReset: Math.round((quotaResetTime - new Date()) / 1000 / 60),
        googleQuotaExceeded,
        googleQuotaExceededAt,
        status: googleQuotaExceeded ? 'exceeded' : used >= total ? 'exceeded' : 'ok',
        cacheStats: {
            keys: youtubeCache.keys().length,
            hits: youtubeCache.getStats().hits || 0,
            misses: youtubeCache.getStats().misses || 0
        }
    };
}

function trackQuotaUsage(cost, operation = 'unknown') {
    resetQuotaIfNeeded();
    dailyQuotaUsed += cost;
    const percentage = Math.round((dailyQuotaUsed / 10000) * 100);
    console.log(`💰 [QUOTA-TRACK] +${cost} for ${operation} | Total: ${dailyQuotaUsed}/10000 (${percentage}%)`);
    saveQuotaData(); // Persist the updated quota
}

function getRemainingQuota() {
    resetQuotaIfNeeded();
    if (googleQuotaExceeded) return 0;
    return 10000 - dailyQuotaUsed;
}

/** Omit null/empty pageToken — passing pageToken= causes YouTube API fetch failures */
function buildYouTubeSearchParams(params) {
    const clean = { ...params };
    if (!clean.pageToken) {
        delete clean.pageToken;
    }
    return clean;
}

function youtubeSearchList(params, retries = 3) {
    const attempt = async (remaining) => {
        try {
            return await youtube.search.list(buildYouTubeSearchParams(params));
        } catch (error) {
            const message = error?.message || String(error);
            const retryable =
                remaining > 1 &&
                (/premature close/i.test(message) ||
                    /ECONNRESET/i.test(message) ||
                    /socket hang up/i.test(message) ||
                    /ETIMEDOUT/i.test(message));

            if (retryable) {
                console.warn(
                    `⚠️ [YOUTUBE-API] Retryable error (${remaining - 1} left):`,
                    message.slice(0, 120)
                );
                await new Promise((resolve) => setTimeout(resolve, 600));
                return attempt(remaining - 1);
            }

            if (isYouTubeQuotaError(error)) {
                markGoogleQuotaExceeded('youtube.search.list');
            }

            throw error;
        }
    };

    return attempt(retries);
}

function sanitizeYouTubeError(error) {
    const message = error?.message || String(error);
    return message.replace(/key=[^&\s]+/gi, 'key=[REDACTED]');
}

function pickYouTubeThumbnail(snippet, videoId) {
    const thumbs = snippet?.thumbnails || {};
    return (
        thumbs.maxres?.url ||
        thumbs.standard?.url ||
        thumbs.high?.url ||
        thumbs.medium?.url ||
        thumbs.default?.url ||
        (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '')
    );
}

/** Drop private / inaccessible / thumbnail-less cards (incl. legacy Mongo cache). */
function filterAccessibleYouTubeVideos(videos = []) {
    return (videos || []).filter((v) => {
        if (!v?.id) return false;
        if (v.privacyStatus === 'private') return false;
        if (v.uploadStatus && v.uploadStatus !== 'processed' && v.uploadStatus !== 'uploaded') {
            return false;
        }
        // Legacy stubs often have empty duration AND empty/broken thumbs for private IDs
        const thumb = String(v.thumbnail || '').trim();
        if (!thumb) return false;
        return true;
    });
}

/**
 * Map search + videos.list details into UI cards.
 * Drop private / missing-details videos (search can still list IDs that
 * videos.list omits — those show as broken thumbnails if kept).
 */
function mapYouTubeVideosFromSearch(searchItems, videoDetailsItems) {
    const detailsById = new Map(
        (videoDetailsItems || []).map((video) => [video.id, video])
    );

    return (searchItems || [])
        .map((item) => {
            const videoId = item?.id?.videoId;
            if (!videoId) return null;

            const video = detailsById.get(videoId);
            // Not returned by videos.list → private, deleted, or inaccessible
            if (!video) return null;

            const privacy = video.status?.privacyStatus;
            if (privacy === 'private') return null;
            // uploadStatus "rejected" / "deleted" / "failed" are not playable
            const upload = video.status?.uploadStatus;
            if (upload && upload !== 'processed' && upload !== 'uploaded') return null;

            const thumbnail = pickYouTubeThumbnail(video.snippet, videoId);
            if (!thumbnail) return null;

            return {
                id: video.id,
                title: video.snippet?.title || item.snippet?.title || 'Unknown Title',
                description: video.snippet?.description || '',
                channelTitle: video.snippet?.channelTitle || item.snippet?.channelTitle || '',
                channelId: video.snippet?.channelId || item.snippet?.channelId || '',
                publishedAt: video.snippet?.publishedAt || '',
                duration: video.contentDetails?.duration || '',
                thumbnail,
                privacyStatus: privacy || 'public',
                uploadStatus: upload || 'processed',
            };
        })
        .filter(Boolean);
}

function extractVideoIds(searchItems) {
    return (searchItems || [])
        .map((item) => item?.id?.videoId)
        .filter(Boolean);
}

function generateCacheKey(query, type, page, pageToken) {
    return `yt_${type}_${query.toLowerCase().replace(/\s+/g, '_')}_p${page}_${pageToken || 'none'}`;
}

// Save YouTube search results to MongoDB for future cache restoration
// PageToken management functions
async function savePageToken(query, searchType, page, pageToken, nextPageToken = null) {
    try {
        await PageToken.findOneAndUpdate(
            { query, searchType, page },
            {
                pageToken,
                nextPageToken,
                lastAccessed: new Date()
            },
            { upsert: true, new: true }
        );
        console.log(`🔑 [PAGETOKEN] Saved pageToken for ${searchType} "${query}" page ${page}`);
    } catch (error) {
        console.error(`🔑 [PAGETOKEN] Failed to save pageToken:`, error);
    }
}

async function getPageToken(query, searchType, page) {
    try {
        const tokenDoc = await PageToken.findOne({ query, searchType, page });
        if (tokenDoc) {
            // Update last accessed time
            tokenDoc.lastAccessed = new Date();
            await tokenDoc.save();
            console.log(`🔑 [PAGETOKEN] Retrieved pageToken for ${searchType} "${query}" page ${page}`);
            return tokenDoc.pageToken;
        }
        return null;
    } catch (error) {
        console.error(`🔑 [PAGETOKEN] Failed to retrieve pageToken:`, error);
        return null;
    }
}

async function getNextPageToken(query, searchType, page) {
    try {
        const tokenDoc = await PageToken.findOne({ query, searchType, page });
        if (tokenDoc && tokenDoc.nextPageToken) {
            console.log(`🔑 [PAGETOKEN] Retrieved nextPageToken for ${searchType} "${query}" page ${page}`);
            return tokenDoc.nextPageToken;
        }
        return null;
    } catch (error) {
        console.error(`🔑 [PAGETOKEN] Failed to retrieve nextPageToken:`, error);
        return null;
    }
}

/** Normalize YouTube query the same way the React client does. */
function foldYouTubeAsciiServer(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/\p{M}/gu, '');
}

function youtubeConsonantSkeletonServer(q) {
    return foldYouTubeAsciiServer(q)
        .toLowerCase()
        .replace(/[^a-z0-9\s.]/g, '')
        .replace(/[aeiou]/g, '')
        .replace(/[.\s]+/g, ' ')
        .trim();
}

/** Accent twin only — not a longer distinct query (Privettriker ≠ PrivettrickerRevival). */
function youtubeQueriesLooselyEqualServer(a, b) {
    const na = normalizeYouTubeQueryKey(a);
    const nb = normalizeYouTubeQueryKey(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.replace(/\./g, '') === nb.replace(/\./g, '')) return true;
    const sa = youtubeConsonantSkeletonServer(na);
    const sb = youtubeConsonantSkeletonServer(nb);
    if (!sa || sa !== sb) return false;
    return Math.abs(na.replace(/\./g, '').length - nb.replace(/\./g, '').length) <= 2;
}

function normalizeYouTubeQueryKey(q) {
    return foldYouTubeAsciiServer(
        String(q || '')
            .replace(/^(?:youtube\s+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)\s+/i, '')
            .trim()
    )
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '.')
        .replace(/[^a-z0-9.]/g, '')
        .replace(/\.+/g, '.')
        .replace(/^\.+|\.+$/g, '');
}

function preferYouTubeDisplayNameServer(...candidates) {
    let best = '';
    const vowelCount = (t) => (foldYouTubeAsciiServer(t).match(/[aeiou]/gi) || []).length;
    for (const raw of candidates) {
        const cleaned = String(raw || '')
            .replace(/^(?:youtube\s+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)\s+/i, '')
            .trim();
        if (!cleaned) continue;
        if (!best) {
            best = cleaned;
            continue;
        }
        const bestUni = /[^\u0000-\u007F]/.test(best);
        const nextUni = /[^\u0000-\u007F]/.test(cleaned);
        if (nextUni && !bestUni) {
            best = cleaned;
            continue;
        }
        if (bestUni && !nextUni) continue;
        const skelBest = youtubeConsonantSkeletonServer(best);
        const skelNext = youtubeConsonantSkeletonServer(cleaned);
        if (skelBest && skelBest === skelNext) {
            if (vowelCount(cleaned) > vowelCount(best)) best = cleaned;
            else if (vowelCount(cleaned) === vowelCount(best) && cleaned.length > best.length) best = cleaned;
            continue;
        }
        if (cleaned.length > best.length) best = cleaned;
    }
    return best;
}

function escapeRegexLiteral(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the best cached YouTubeSearch doc for a query.
 * Prefer the document with the most videoResults pages so we never
 * miss an older full Santana cache when a newer 1-page stub exists.
 */
/**
 * Find a youtube_searches row for this query even when videoResults is empty
 * (bookmark / history shell with no cached pages).
 */
async function findYouTubeSearchMeta(query, ownerId = null) {
    const normalized = normalizeYouTubeQueryKey(query);
    const variants = [...new Set([
        query,
        String(query || '').trim(),
        String(query || '').trim().toLowerCase(),
        normalized,
        normalized.replace(/\./g, ' '),
    ].filter(Boolean))];

    const ownerFilter = ownerId ? { userId: ownerId } : {};

    for (const variant of variants) {
        const match = await YouTubeSearch.findOne({
            ...ownerFilter,
            $or: [
                { query: { $regex: new RegExp(`^${escapeRegexLiteral(variant)}$`, 'i') } },
                { displayName: { $regex: new RegExp(`^${escapeRegexLiteral(variant)}$`, 'i') } },
            ],
        }).sort({ lastSearched: -1 });
        if (match) return match;
    }

    if (normalized) {
        const candidates = await YouTubeSearch.find(ownerFilter)
            .sort({ lastSearched: -1 })
            .limit(800);
        for (const doc of candidates) {
            if (normalizeYouTubeQueryKey(doc.query) === normalized) return doc;
            if (normalizeYouTubeQueryKey(doc.displayName) === normalized) return doc;
            if (
                youtubeQueriesLooselyEqualServer(normalized, doc.query) ||
                youtubeQueriesLooselyEqualServer(normalized, doc.displayName)
            ) {
                return doc;
            }
        }
    }
    return null;
}

/**
 * Best cached document for a query.
 *
 * Pass ownerId when the caller intends to modify the result. Without it the
 * search spans every account, which is fine for serving cached video pages
 * (it saves API quota and the caller already supplied the query) but would
 * otherwise let one user adopt and rewrite another user's saved search.
 */
async function findBestYouTubeSearchCache(query, ownerId = null) {
    const normalized = normalizeYouTubeQueryKey(query);
    const variants = [...new Set([
        query,
        String(query || '').trim(),
        String(query || '').trim().toLowerCase(),
        normalized,
        normalized.replace(/\./g, ' '),
    ].filter(Boolean))];

    const ownerFilter = ownerId ? { userId: ownerId } : {};
    const scored = [];

    for (const variant of variants) {
        const matches = await YouTubeSearch.find({
            ...ownerFilter,
            $or: [
                { query: { $regex: new RegExp(`^${escapeRegexLiteral(variant)}$`, 'i') } },
                { displayName: { $regex: new RegExp(`^${escapeRegexLiteral(variant)}$`, 'i') } },
            ],
            'videoResults.0': { $exists: true },
        }).limit(20);
        for (const doc of matches) {
            if (doc?.videoResults?.length) scored.push(doc);
        }
    }

    // Normalized-key scan across recent docs (covers legacy un-normalized query fields)
    if (normalized) {
        const candidates = await YouTubeSearch.find({
            ...ownerFilter,
            'videoResults.0': { $exists: true },
        })
            .sort({ lastSearched: -1 })
            .limit(800);
        for (const doc of candidates) {
            if (normalizeYouTubeQueryKey(doc.query) === normalized) scored.push(doc);
            else if (normalizeYouTubeQueryKey(doc.displayName) === normalized) scored.push(doc);
            else if (
                youtubeQueriesLooselyEqualServer(normalized, doc.query) ||
                youtubeQueriesLooselyEqualServer(normalized, doc.displayName)
            ) {
                // Accent twins only (sigur.rs ↔ sigur.ros) — not longer distinct names
                scored.push(doc);
            }
        }
    }

    if (!scored.length) return null;

    const byId = new Map();
    for (const doc of scored) {
        const id = String(doc._id);
        const prev = byId.get(id);
        if (!prev || (doc.videoResults?.length || 0) > (prev.videoResults?.length || 0)) {
            byId.set(id, doc);
        }
    }

    return [...byId.values()].sort(
        (a, b) => (b.videoResults?.length || 0) - (a.videoResults?.length || 0)
    )[0];
}

/** Merge page arrays by page number — never drop already-cached pages. */
function mergeYouTubeVideoResults(existing = [], incoming = []) {
    const byPage = new Map();
    for (const p of existing || []) {
        if (p && p.page != null) byPage.set(Number(p.page), p);
    }
    for (const p of incoming || []) {
        if (p && p.page != null) byPage.set(Number(p.page), p);
    }
    return [...byPage.values()].sort((a, b) => Number(a.page) - Number(b.page));
}

async function saveSearchResultToMongoDB(query, page, videos, resultType, nextPageToken = null, quotaUsed = 101) {
    try {
        // Create the video result data
        const videoResultData = {
            page,
            videos,
            resultType,
            nextPageToken,
            totalResults: videos.length,
            apiQuotaUsed: quotaUsed,
            timestamp: new Date()
        };

        const normalizedQuery = normalizeYouTubeQueryKey(query);

        // Prefer fullest existing cache (legacy keys + normalized), then update in place
        let searchDoc = await findBestYouTubeSearchCache(query);
        if (
            searchDoc &&
            !youtubeQueriesLooselyEqualServer(query, searchDoc.query) &&
            !youtubeQueriesLooselyEqualServer(query, searchDoc.displayName)
        ) {
            // Never merge into a different channel/search just because findBest scored it highest
            searchDoc = null;
        }
        if (!searchDoc) {
            searchDoc = await YouTubeSearch.findOne({ query: normalizedQuery });
        }

        if (!searchDoc) {
            const humanReadableDisplay = normalizedQuery.replace(/\./g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            const niceDisplay = preferYouTubeDisplayNameServer(
                String(query || '').replace(/^(?:youtube\s+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)\s+/i, '').trim(),
                humanReadableDisplay
            );

            // Create new search document — cache pages only, NOT user-saved bookmark
            searchDoc = new YouTubeSearch({
                query: normalizedQuery, // Store normalized query
                userId: 'default-user',
                displayName: niceDisplay, // Human-readable display name
                videoCount: videos.length,
                lastSearched: new Date(),
                dateCreated: new Date(),
                videoResults: [videoResultData],
                isSaved: false
            });
            await searchDoc.save();
        } else {
            // Keep canonical normalized key so future lookups hit this doc
            const incomingKey = normalizedQuery || searchDoc.query;
            const skelIncoming = youtubeConsonantSkeletonServer(incomingKey);
            const skelExisting = youtubeConsonantSkeletonServer(searchDoc.query);
            // Prefer vowel-complete key (sigur.ros over legacy sigur.rs) only for true twins
            if (
                youtubeQueriesLooselyEqualServer(incomingKey, searchDoc.query) &&
                skelIncoming &&
                skelIncoming === skelExisting &&
                (incomingKey.match(/[aeiou]/gi) || []).length >
                    (String(searchDoc.query || '').match(/[aeiou]/gi) || []).length
            ) {
                searchDoc.query = incomingKey;
            } else if (normalizeYouTubeQueryKey(searchDoc.query) === incomingKey) {
                searchDoc.query = incomingKey || searchDoc.query;
            }
            // Do not rename a different search's query field to the incoming key
            searchDoc.displayName = preferYouTubeDisplayNameServer(
                searchDoc.displayName,
                String(query || '').replace(/^(?:youtube\s+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)\s+/i, '').trim(),
                String(searchDoc.query || '').replace(/\./g, ' ').replace(/\b\w/g, l => l.toUpperCase())
            );
            if (!Array.isArray(searchDoc.videoResults)) searchDoc.videoResults = [];
            const existingPageIndex = searchDoc.videoResults.findIndex(result => Number(result.page) === Number(page));

            if (existingPageIndex >= 0) {
                searchDoc.videoResults[existingPageIndex] = videoResultData;
            } else {
                searchDoc.videoResults.push(videoResultData);
            }

            searchDoc.lastSearched = new Date();
            searchDoc.videoCount = searchDoc.videoResults.reduce((total, result) => total + (result.videos?.length || 0), 0);
            searchDoc.totalPages = searchDoc.videoResults.length;
            if (searchDoc.isSaved == null) searchDoc.isSaved = false;

            await searchDoc.save();
        }

        console.log(`💾 [MONGODB] Saved ${videos.length} videos for "${query}" page ${page} to consolidated youtube_searches collection (${searchDoc.videoResults.length} pages total)`);
    } catch (error) {
        console.error('❌ [MONGODB] Error saving search result:', error);
    }
}

/** Return a cached page from MongoDB without using YouTube API quota. */
async function getMongoCachedSearchPage(query, page = 1) {
    const searchDoc = await findBestYouTubeSearchCache(query);
    if (!searchDoc?.videoResults?.length) return null;

    const pageResult = searchDoc.videoResults.find((r) => Number(r.page) === Number(page));
    if (!pageResult?.videos?.length) return null;

    const videos = filterAccessibleYouTubeVideos(pageResult.videos);

    if (!videos.length) return null;

    return {
        success: true,
        videos,
        resultType: pageResult.resultType || 'MULTI',
        isMock: false,
        page: Number(page),
        nextPageToken: pageResult.nextPageToken || null,
        fromCache: true,
        cacheSource: 'mongodb-server',
        searchType: 'search',
        totalPages: searchDoc.videoResults.length
    };
}

async function getCachedOrFetch(cacheKey, fetchFunction, quotaCost) {
    // Check cache first
    const cached = youtubeCache.get(cacheKey);
    if (cached) {
        console.log('✓ Cache HIT for:', cacheKey);
        return { ...cached, fromCache: true };
    }

    resetQuotaIfNeeded();

    // Never hard-block forever on a local exceeded latch — Google may have reset,
    // or the flag may be a false positive. Always attempt the API; clear the latch
    // after a successful call. Empty Mongo history must not prevent live searches.
    if (googleQuotaExceeded) {
        const markedAt = googleQuotaExceededAt ? Date.parse(googleQuotaExceededAt) : 0;
        const ageMs = markedAt ? Date.now() - markedAt : Infinity;
        if (ageMs > 12 * 60 * 60 * 1000) {
            console.warn(
                `⚠️ [QUOTA] Clearing stale googleQuotaExceeded flag (>${Math.round(ageMs / 3600000)}h old) — retrying YouTube API`
            );
            googleQuotaExceeded = false;
            googleQuotaExceededAt = null;
            saveQuotaData();
        } else {
            console.warn(
                '⚠️ [QUOTA] googleQuotaExceeded is set — still attempting YouTube API to verify'
            );
        }
    }

    // Check if we have enough quota
    if (getRemainingQuota() < quotaCost && !googleQuotaExceeded) {
        throw new Error(`Quota exceeded: ${dailyQuotaUsed}/10000 calls used. Resets at ${quotaResetTime.toISOString()}`);
    }

    // EMERGENCY: Block API calls only when very close to limit (>90% = 9000 quota)
    // Skip this soft block when we are probing after a googleQuotaExceeded latch.
    if (dailyQuotaUsed > 9000 && !googleQuotaExceeded) {
        console.warn(`🚨 [QUOTA-EMERGENCY] Blocking API call - usage critically high: ${dailyQuotaUsed}/10000`);
        throw new Error(`Emergency quota conservation: ${dailyQuotaUsed}/10000 calls used. Daily limit nearly reached.`);
    }

    // WARNING: Log warnings at 80% and 90% but don't block
    if (dailyQuotaUsed > 8000 && dailyQuotaUsed <= 9000) {
        console.warn(`⚠️ [QUOTA-WARNING] High usage: ${dailyQuotaUsed}/10000 (${Math.round(dailyQuotaUsed/100)}%)`);
    }

    // Check for pending identical request (deduplication)
    if (pendingRequests.has(cacheKey)) {
        console.log('⏳ Deduplicating request:', cacheKey);
        return await pendingRequests.get(cacheKey);
    }

    // Execute request
    const promise = fetchFunction();
    pendingRequests.set(cacheKey, promise);

    try {
        const result = await promise;
        trackQuotaUsage(quotaCost, `API-${cacheKey}`);

        if (googleQuotaExceeded) {
            console.log('✓ [QUOTA] YouTube API succeeded — clearing googleQuotaExceeded latch');
            googleQuotaExceeded = false;
            googleQuotaExceededAt = null;
            saveQuotaData();
        }

        // Cache successful results
        if (result && result.success) {
            youtubeCache.set(cacheKey, result);
            console.log('✓ Cached result for:', cacheKey);
        }

        return result;
    } catch (error) {
        console.error('❌ [CACHE-FETCH] YouTube API request failed for key:', cacheKey);
        console.error('❌ [CACHE-FETCH] Error details:', {
            message: error.message,
            stack: error.stack?.split('\n').slice(0, 5).join('\n'), // First 5 lines of stack
            code: error.code,
            status: error.status,
            statusText: error.statusText,
            quotaUsed: dailyQuotaUsed,
            quotaCost: quotaCost
        });
        throw error; // Propagate the actual error instead of returning null
    } finally {
        pendingRequests.delete(cacheKey);
    }
}

router.post('/search', async (req, res) => {
    const { query = '', type = 'search', page = 1 } = req.body;
    console.log('YouTube Search POST body:', req.body);
    console.log('Query received:', query, '| Type received:', type, '| Page:', page);

    // Real YouTube API with caching and optimization
    if (!process.env.GOOGLE_API_KEY) {
        console.log('⚠️ No API key available');
        return res.status(500).json({
            success: false,
            error: 'YouTube API key not configured',
            videos: [],
            isMock: false
        });
    }

    const cacheKey = generateCacheKey(query, type, page, req.body.pageToken);

    if (type === 'play') {
        // SINGLE video search with optimization
        try {
            const result = await getCachedOrFetch(cacheKey, async () => {
                console.log('🔍 Real API: Searching for single video:', query);

                const searchResponse = await youtubeSearchList({
                    part: ['snippet'],
                    q: query,
                    maxResults: 1,
                    type: 'video'
                });

                if (!searchResponse?.data?.items?.length) {
                    return { success: false, videos: [], error: 'No videos found for this query' };
                }

                const videoIds = searchResponse.data.items.map(item => item.id.videoId);

                // Get full video details in single batch call
                const videoDetails = await youtube.videos.list({
                    part: ['snippet', 'contentDetails', 'status'],
                    id: videoIds.join(',')
                });

                const videos = filterAccessibleYouTubeVideos(
                    (videoDetails.data.items || []).map((video) => {
                        const privacy = video.status?.privacyStatus;
                        const upload = video.status?.uploadStatus;
                        if (privacy === 'private') return null;
                        if (upload && upload !== 'processed' && upload !== 'uploaded') return null;
                        const thumbnail = pickYouTubeThumbnail(video.snippet, video.id);
                        if (!thumbnail) return null;
                        return {
                            id: video.id,
                            title: video.snippet.title,
                            description: video.snippet.description,
                            channelTitle: video.snippet.channelTitle,
                            channelId: video.snippet.channelId || '',
                            publishedAt: video.snippet.publishedAt,
                            duration: video.contentDetails.duration,
                            thumbnail,
                            privacyStatus: privacy || 'public',
                            uploadStatus: upload || 'processed',
                        };
                    }).filter(Boolean)
                );

                // NOTE: MongoDB saving is now OPTIONAL - only happens when user clicks SAVE button
                console.log(`🎬 [SEARCH] Single video result saved to localStorage only - use SAVE button to persist to MongoDB`);

                return {
                    success: true,
                    videos,
                    resultType: 'SINGLE',
                    isMock: false
                };
            }, 101); // search.list (100) + videos.list (1)

            return res.json({
                ...result,
                quota: {
                    used: dailyQuotaUsed,
                    limit: 10000
                }
            });
        } catch (error) {
            console.error('YouTube API error for single video search:', error);

            // Check for quota exceeded error
            if (error.message && error.message.includes('quota') && error.message.includes('exceeded')) {
                console.error('🚫 [QUOTA-EXCEEDED] YouTube API quota limit reached');
                return res.status(403).json({
                    success: false,
                    error: 'YouTube API quota limit reached',
                    quotaExceeded: true,
                    details: sanitizeYouTubeError(error),
                    videos: [],
                    isMock: false
                });
            }

            return res.status(500).json({
                success: false,
                error: 'YouTube API request failed',
                details: sanitizeYouTubeError(error),
                videos: [],
                isMock: false
            });
        }
    }

    if (type === 'search' || type === 'channel') {
        // MULTI video search with optimization
        const perPage = 12;
        const pageNum = Math.max(1, Number(page) || 1);
        const clientPageToken = req.body.pageToken || null;

        // Declare quotaCostMultiplier outside the callback so it's accessible
        let quotaCostMultiplier = 1; // Track actual API calls made

        // MongoDB page cache BEFORE any YouTube API / quota spend
        if (type === 'search') {
            try {
                const mongoHit = await getMongoCachedSearchPage(query, pageNum);
                if (mongoHit) {
                    console.log(`✓ [MONGODB] Serving page ${pageNum} for "${query}" — no API quota used`);
                    // Warm in-memory cache too
                    try {
                        youtubeCache.set(cacheKey, { ...mongoHit, fromCache: true });
                    } catch { /* ignore */ }
                    return res.json({
                        ...mongoHit,
                        quota: {
                            used: dailyQuotaUsed,
                            limit: 10000
                        }
                    });
                }
                const emptyShell = await findYouTubeSearchMeta(query);
                if (emptyShell && !(emptyShell.videoResults || []).some((p) => p?.videos?.length)) {
                    console.warn(
                        `⚠️ [MONGODB] History shell for "${query}" has no cached video pages — will try YouTube API`
                    );
                }
            } catch (mongoErr) {
                console.warn('⚠️ [MONGODB] Lookup failed, continuing to API:', mongoErr.message);
            }
        }

        try {
            const result = await getCachedOrFetch(cacheKey, async () => {
                console.log(`🔍 Real API: ${type} search:`, query, 'page:', pageNum);

                let channelId = null;
                if (type === 'channel') {
                    const channelLookup = await youtubeSearchList({
                        part: ['snippet'],
                        q: query,
                        maxResults: 1,
                        type: 'channel'
                    });
                    quotaCostMultiplier++;
                    channelId = channelLookup?.data?.items?.[0]?.id?.channelId;
                    if (!channelId) {
                        return { success: false, videos: [], error: `Channel not found for "${query}"` };
                    }
                }

                const buildSearchParams = (token) => {
                    const params = {
                        part: ['snippet'],
                        maxResults: perPage,
                        type: 'video'
                    };
                    if (token) params.pageToken = token;
                    if (channelId) {
                        params.channelId = channelId;
                    } else {
                        params.q = query;
                    }
                    return params;
                };

                let pageToken = clientPageToken;
                let searchResponse = null;

                if (pageNum > 1) {
                    if (!pageToken) {
                        const prevPageCacheKey = generateCacheKey(query, type, pageNum - 1);
                        const prevPageCache = youtubeCache.get(prevPageCacheKey);

                        if (prevPageCache && prevPageCache.nextPageToken) {
                            pageToken = prevPageCache.nextPageToken;
                            console.log(`💰 [QUOTA-EFFICIENT] Using server cached pageToken from page ${pageNum - 1} for page ${pageNum}`);
                        }
                    } else {
                        console.log(`💰 [QUOTA-EFFICIENT] Using client-provided pageToken for page ${pageNum}`);
                    }

                    if (!pageToken) {
                        console.log(`💸 [QUOTA-EXPENSIVE] No pageToken found, building up to page ${pageNum}...`);
                        let currentPage = 1;
                        let response = await youtubeSearchList(buildSearchParams(null));
                        quotaCostMultiplier++;

                        while (currentPage < pageNum && response.data.nextPageToken) {
                            pageToken = response.data.nextPageToken;
                            response = await youtubeSearchList(buildSearchParams(pageToken));
                            quotaCostMultiplier++;
                            currentPage++;
                        }

                        if (currentPage === pageNum && response?.data?.items?.length) {
                            searchResponse = response;
                            console.log(`💸 [QUOTA-EXPENSIVE] Reached page ${pageNum} during build-up (${quotaCostMultiplier} search calls)`);
                        } else if (currentPage < pageNum) {
                            return {
                                success: false,
                                videos: [],
                                error: `Only ${currentPage} page(s) available for this query`
                            };
                        }
                    }
                }

                if (!searchResponse) {
                    try {
                        console.log('🔍 [YOUTUBE-API] Making search request with pageToken:', pageToken || 'none');
                        searchResponse = await youtubeSearchList(buildSearchParams(pageToken));
                        if (pageNum > 1) quotaCostMultiplier++;
                    } catch (tokenError) {
                        if (pageToken && pageNum > 1) {
                            console.warn('⚠️ [YOUTUBE-API] pageToken failed, rebuilding from page 1:', sanitizeYouTubeError(tokenError));
                            pageToken = null;
                            let currentPage = 1;
                            let response = await youtubeSearchList(buildSearchParams(null));
                            quotaCostMultiplier++;

                            while (currentPage < pageNum && response.data.nextPageToken) {
                                pageToken = response.data.nextPageToken;
                                response = await youtubeSearchList(buildSearchParams(pageToken));
                                quotaCostMultiplier++;
                                currentPage++;
                            }

                            if (currentPage === pageNum && response?.data?.items?.length) {
                                searchResponse = response;
                            } else {
                                throw tokenError;
                            }
                        } else {
                            throw tokenError;
                        }
                    }
                }

                console.log('🔍 [YOUTUBE-API] Search response received:', {
                    hasData: !!searchResponse?.data,
                    hasItems: !!searchResponse?.data?.items,
                    itemsCount: searchResponse?.data?.items?.length || 0,
                    nextPageToken: !!searchResponse?.data?.nextPageToken
                });

                if (!searchResponse?.data?.items?.length) {
                    return { success: false, videos: [], error: 'No videos found for this query' };
                }

                const videoIds = extractVideoIds(searchResponse.data.items);
                console.log('🔍 [YOUTUBE-API] Video IDs extracted:', videoIds.length, 'videos');

                if (!videoIds.length) {
                    return { success: false, videos: [], error: 'No playable videos found for this query' };
                }

                const videoDetails = await youtube.videos.list({
                    part: ['snippet', 'contentDetails', 'status'],
                    id: videoIds.join(',')
                });

                console.log('🔍 [YOUTUBE-API] Video details response received:', {
                    hasData: !!videoDetails?.data,
                    hasItems: !!videoDetails?.data?.items,
                    itemsCount: videoDetails?.data?.items?.length || 0
                });

                const videos = mapYouTubeVideosFromSearch(
                    searchResponse.data.items,
                    videoDetails?.data?.items
                );

                console.log(`🎬 [SEARCH] Persisting page ${pageNum} to MongoDB for future cache restores`);

                const actualQuotaCost = (quotaCostMultiplier * 100) + 1;
                console.log(`💰 [QUOTA] Page ${pageNum} cost: ${actualQuotaCost} quota (${quotaCostMultiplier} search calls + 1 video details call)`);

                // Persist so next localStorage miss can restore from Mongo without quota
                await saveSearchResultToMongoDB(
                    query,
                    pageNum,
                    videos,
                    'MULTI',
                    searchResponse.data.nextPageToken || null,
                    actualQuotaCost
                );

                return {
                    success: true,
                    videos,
                    resultType: 'MULTI',
                    isMock: false,
                    page: pageNum,
                    nextPageToken: searchResponse.data.nextPageToken,
                    fromCache: false,
                    searchType: type
                };
            }, (quotaCostMultiplier * 100) + 1);
            return res.json({
                ...result,
                quota: {
                    used: dailyQuotaUsed,
                    limit: 10000
                }
            });
        } catch (error) {
            console.error('YouTube API error for multi-search:', error);

            // Check for quota exceeded error
            if (isYouTubeQuotaError(error)) {
                markGoogleQuotaExceeded('multi-search');
                console.error('🚫 [QUOTA-EXCEEDED] YouTube API quota limit reached');
                return res.status(403).json({
                    success: false,
                    error: 'YouTube API quota limit reached',
                    quotaExceeded: true,
                    details: sanitizeYouTubeError(error),
                    videos: [],
                    isMock: false,
                    quota: getQuotaStatus()
                });
            }

            // Prefer Google's real error — empty History is normal for first-time searches
            // and must not sound like the reason the search is blocked.
            const apiDetail = sanitizeYouTubeError(error);
            let note = '';
            try {
                const shell = await findYouTubeSearchMeta(query);
                const hasPages = (shell?.videoResults || []).some((p) => p?.videos?.length);
                if (shell && !hasPages) {
                    note =
                        `History lists “${shell.displayName || query}” with no saved pages yet; ` +
                        'once the API succeeds, click Save to cache them.';
                }
            } catch { /* ignore */ }

            return res.status(500).json({
                success: false,
                error: apiDetail
                    ? `YouTube API request failed: ${apiDetail}`
                    : 'YouTube API request failed',
                details: apiDetail,
                note: note || undefined,
                videos: [],
                isMock: false,
                cacheEmpty: Boolean(note),
            });
        }
    }

    if (type === 'movies' || type === 'tv') {
        // Movies & TV search - searches for movies and TV content on YouTube
        const perPage = 12;
        const pageNum = Math.max(1, Number(page) || 1);

        // Calculate quota cost upfront - more conservative for movies/TV
        let quotaUsed = 101; // Base cost: search.list (100) + videos.list (1)
        if (pageNum > 1) {
            // Check if we can use cached pageToken (efficient) or need to build up (expensive)
            const prevPageCacheKey = generateCacheKey(query, type, pageNum - 1);
            const prevPageCache = youtubeCache.get(prevPageCacheKey);

            if (prevPageCache && prevPageCache.nextPageToken) {
                // Efficient: Only one additional API call needed
                quotaUsed = 101;
            } else {
                // Expensive: Need to build up through all pages
                quotaUsed += (pageNum - 1) * 100; // Additional search.list calls for pagination
            }
        }

        try {
            const result = await getCachedOrFetch(cacheKey, async () => {
                console.log('🎬 Real API: Movies & TV search:', query, 'page:', pageNum, 'type:', type);

                // Enhanced query for better movie/TV results
                let searchQuery = query;
                let searchParams = {
                    part: ['snippet'],
                    q: searchQuery,
                    maxResults: perPage,
                    type: 'video',
                    order: 'relevance' // Most relevant first for movies/TV
                };

                if (type === 'movies') {
                    // FULL-LENGTH MOVIE SEARCH - Optimized for actual movies, not trailers
                    searchQuery = `${query} full movie complete film`;
                    searchParams.videoDuration = 'long';     // Only videos longer than 20 minutes
                    searchParams.videoDefinition = 'high';   // Only HD videos
                    console.log('🎬 [MOVIES] Using full-length movie search parameters');
                } else if (type === 'tv') {
                    // TV SHOW SEARCH - Optimized for episodes and series
                    searchQuery = `${query} tv show series episode full episode`;
                    searchParams.videoDuration = 'medium';   // 4-20 minutes (typical TV episode length)
                    searchParams.videoDefinition = 'high';   // Only HD videos
                    console.log('📺 [TV] Using TV episode search parameters');
                }

                searchParams.q = searchQuery;

                // Handle pagination for movies & TV search - SUSTAINABLE VERSION
                let currentPageToken = null;

                if (pageNum > 1) {
                    // STEP 1: Check persistent pageToken database first
                    currentPageToken = await getNextPageToken(query, type, pageNum - 1);

                    if (currentPageToken) {
                        console.log(`🎬 [SUSTAINABLE] Using persistent pageToken from database for ${type} page ${pageNum}`);
                    } else {
                        // STEP 2: Check in-memory cache as fallback
                        const prevPageCacheKey = generateCacheKey(query, type, pageNum - 1);
                        const prevPageCache = youtubeCache.get(prevPageCacheKey);

                        if (prevPageCache && prevPageCache.nextPageToken) {
                            currentPageToken = prevPageCache.nextPageToken;
                            console.log(`🎬 [SUSTAINABLE] Using in-memory cached pageToken for ${type} page ${pageNum}`);
                        } else {
                            // STEP 3: Build up efficiently with database storage
                            console.log(`🎬 [SUSTAINABLE] Building pageToken chain for ${type} "${query}" up to page ${pageNum}`);

                            let currentPage = 1;
                            let tempPageToken = null;

                            // Start from page 1 or the highest page we have stored
                            const existingTokens = await PageToken.find({ query, searchType: type }).sort({ page: -1 }).limit(1);
                            if (existingTokens.length > 0) {
                                currentPage = existingTokens[0].page + 1;
                                tempPageToken = existingTokens[0].nextPageToken;
                                console.log(`🎬 [SUSTAINABLE] Resuming from stored page ${existingTokens[0].page} for ${type} search`);
                            }

                            // Build up to target page, storing each pageToken
                            while (currentPage <= pageNum) {
                                const tempResponse = await youtubeSearchList({
                                    ...searchParams,
                                    pageToken: tempPageToken
                                });

                                if (!tempResponse.data.items || tempResponse.data.items.length === 0) {
                                    console.log(`🎬 [SUSTAINABLE] Reached end of results at page ${currentPage} for ${type} search`);
                                    return {
                                        success: true,
                                        videos: [],
                                        resultType: 'MULTI',
                                        isMock: false,
                                        page: pageNum,
                                        nextPageToken: null,
                                        contentType: type,
                                        fromCache: false,
                                        endOfResults: true
                                    };
                                }

                                // Save this pageToken to database for future use
                                await savePageToken(query, type, currentPage, tempPageToken, tempResponse.data.nextPageToken);

                                if (currentPage === pageNum) {
                                    currentPageToken = tempPageToken;
                                    break;
                                }

                                tempPageToken = tempResponse.data.nextPageToken;
                                if (!tempPageToken) {
                                    console.log(`🎬 [SUSTAINABLE] No more pages available for ${type} search`);
                                    return {
                                        success: true,
                                        videos: [],
                                        resultType: 'MULTI',
                                        isMock: false,
                                        page: pageNum,
                                        nextPageToken: null,
                                        contentType: type,
                                        fromCache: false,
                                        endOfResults: true
                                    };
                                }

                                currentPage++;
                                console.log(`🎬 [SUSTAINABLE] Built pageToken for page ${currentPage - 1}, continuing to page ${currentPage}`);
                            }
                        }
                    }
                }

                // Set the correct pageToken for the final search
                searchParams.pageToken = currentPageToken;
                const searchResponse = await youtubeSearchList(searchParams);

                if (!searchResponse?.data?.items?.length) {
                    return { success: false, videos: [], error: `No ${type} content found for this query` };
                }

                const videoIds = extractVideoIds(searchResponse.data.items);
                if (!videoIds.length) {
                    return { success: false, videos: [], error: `No playable ${type} videos found for this query` };
                }

                const videoDetails = await youtube.videos.list({
                    part: ['snippet', 'contentDetails', 'status'],
                    id: videoIds.join(',')
                });

                const videos = mapYouTubeVideosFromSearch(
                    searchResponse.data.items,
                    videoDetails?.data?.items
                ).map((video) => ({
                    ...video,
                    contentType: type
                }));

                // NOTE: MongoDB saving is now OPTIONAL - only happens when user clicks SAVE button
                // Search results go to localStorage only (temporary)
                console.log(`🎬 [SEARCH] Search results saved to localStorage only - use SAVE button to persist to MongoDB`);

                // Save pageToken for sustainable pagination
                try {
                    await savePageToken(query, type, pageNum, currentPageToken, searchResponse.data.nextPageToken);
                    console.log(`🎬 [SUSTAINABLE] Saved pageToken for future pagination`);
                } catch (pageTokenError) {
                    console.error(`🎬 [SUSTAINABLE] Failed to save pageToken:`, pageTokenError);
                }

                return {
                    success: true,
                    videos,
                    resultType: 'MULTI',
                    isMock: false,
                    page: pageNum,
                    nextPageToken: searchResponse.data.nextPageToken,
                    contentType: type,
                    fromCache: false
                };
            }, quotaUsed); // Dynamic quota cost based on pagination

            return res.json({
                ...result,
                quota: {
                    used: dailyQuotaUsed,
                    limit: 10000
                }
            });
        } catch (error) {
            console.error(`YouTube API error for ${type} search:`, error);

            // Check if it's a quota-related error
            if (error.message && error.message.includes('Quota exceeded')) {
                return res.status(429).json({
                    success: false,
                    error: `Quota limit reached for ${type} search`,
                    details: sanitizeYouTubeError(error),
                    videos: [],
                    isMock: false,
                    quotaExceeded: true,
                    quota: {
                        used: dailyQuotaUsed,
                        limit: 10000,
                        resetTime: quotaResetTime.toISOString()
                    }
                });
            }

            // Check if it's a quota conservation error
            if (error.message && error.message.includes('quota conservation')) {
                return res.status(429).json({
                    success: false,
                    error: `Quota conservation active for ${type} search`,
                    details: sanitizeYouTubeError(error),
                    videos: [],
                    isMock: false,
                    quotaConservation: true,
                    quota: {
                        used: dailyQuotaUsed,
                        limit: 10000,
                        resetTime: quotaResetTime.toISOString()
                    }
                });
            }

            return res.status(500).json({
                success: false,
                error: `YouTube API request failed (${type} search)`,
                details: sanitizeYouTubeError(error),
                videos: [],
                isMock: false,
                quota: {
                    used: dailyQuotaUsed,
                    limit: 10000
                }
            });
        }
    }

    // Fallback for unrecognized types
    return res.json({ success: false, videos: [], resultType: 'NONE', isMock: false });
});

// Add quota status and cache management endpoints
router.get('/quota-status', (req, res) => {
    res.json(getQuotaStatus());
});

/** Resolve a channel for in-app player (prefer videoId → UC…, else name search). */
router.get('/resolve-channel', async (req, res) => {
    try {
        const videoId = String(req.query.videoId || '').trim();
        const q = String(req.query.q || '').trim();

        // Cheapest path: channelId from an existing video (1 quota unit)
        if (videoId) {
            const videoResponse = await youtube.videos.list({
                part: ['snippet'],
                id: [videoId],
            });
            const snip = videoResponse?.data?.items?.[0]?.snippet;
            const channelId = snip?.channelId || '';
            if (channelId) {
                return res.json({
                    success: true,
                    channelId,
                    channelTitle: snip?.channelTitle || q || channelId,
                });
            }
        }

        if (!q) {
            return res.status(400).json({
                success: false,
                error: 'q or videoId is required',
            });
        }

        // Already a channel id
        if (/^UC[\w-]{20,}$/i.test(q)) {
            return res.json({ success: true, channelId: q, channelTitle: q });
        }

        const response = await youtubeSearchList({
            part: ['snippet'],
            q,
            type: 'channel',
            maxResults: 1,
        });
        const item = response?.data?.items?.[0];
        const channelId = item?.id?.channelId || item?.snippet?.channelId || '';
        const channelTitle = item?.snippet?.title || q;
        if (!channelId) {
            return res.status(404).json({
                success: false,
                error: 'No YouTube channel found for that name',
            });
        }
        return res.json({ success: true, channelId, channelTitle });
    } catch (error) {
        console.error('[youtube/resolve-channel]', error?.message || error);
        if (isYouTubeQuotaError(error)) {
            markGoogleQuotaExceeded('resolve-channel');
            return res.status(403).json({
                success: false,
                error: 'YouTube API quota exceeded',
            });
        }
        return res.status(500).json({
            success: false,
            error: sanitizeYouTubeError(error) || 'Failed to resolve channel',
        });
    }
});

router.post('/quota-google-exceeded', (req, res) => {
    markGoogleQuotaExceeded(req.body?.source || 'client');
    res.json({ success: true, quota: getQuotaStatus() });
});

// Test YouTube API quota status with minimal API call
router.post('/test-quota', async (req, res) => {
    try {
        console.log('🧪 [QUOTA-TEST] Testing YouTube API quota status...');

        // Make a minimal YouTube API call to test quota
        const searchResponse = await youtubeSearchList({
            part: ['snippet'],
            q: 'test',
            maxResults: 1,
            type: 'video'
        });

        if (searchResponse && searchResponse.data && searchResponse.data.items) {
            console.log('✅ [QUOTA-TEST] YouTube API quota OK');
            res.json({
                success: true,
                quotaExceeded: false,
                message: 'YouTube API quota is available'
            });
        } else {
            console.log('⚠️ [QUOTA-TEST] Unexpected API response');
            res.json({
                success: false,
                quotaExceeded: false,
                message: 'Unexpected API response'
            });
        }
    } catch (error) {
        console.error('❌ [QUOTA-TEST] YouTube API error:', error.message);

        // Check if error indicates quota exceeded
        const isQuotaError = error.message.includes('quota') ||
                            error.message.includes('Quota') ||
                            error.code === 403 ||
                            error.status === 403;

        if (isQuotaError) {
            markGoogleQuotaExceeded('test-quota');
            console.log('🚫 [QUOTA-TEST] YouTube API quota limit reached');
            res.status(403).json({
                success: false,
                quotaExceeded: true,
                error: 'YouTube API quota limit reached',
                message: error.message,
                quota: getQuotaStatus()
            });
        } else {
            console.log('❌ [QUOTA-TEST] Other API error:', error.message);
            res.status(500).json({
                success: false,
                quotaExceeded: false,
                error: 'API test failed',
                message: error.message
            });
        }
    }
});

// Admin endpoint to manually set quota usage (for fixing quota tracking)
router.post('/quota-set', (req, res) => {
    const { used } = req.body;

    if (typeof used !== 'number' || used < 0 || used > 10000) {
        return res.status(400).json({
            success: false,
            error: 'Invalid quota usage. Must be a number between 0 and 10000.'
        });
    }

    const oldUsed = dailyQuotaUsed;
    dailyQuotaUsed = used;
    if (used < 10000) {
        googleQuotaExceeded = false;
        googleQuotaExceededAt = null;
    }
    saveQuotaData();

    console.log(`📊 [QUOTA] Manual quota adjustment: ${oldUsed} → ${dailyQuotaUsed}`);

    res.json({
        success: true,
        message: `Quota usage updated from ${oldUsed} to ${dailyQuotaUsed}`,
        quota: getQuotaStatus()
    });
});

router.post('/quota-reset', (req, res) => {
    const oldUsed = dailyQuotaUsed;
    dailyQuotaUsed = 0;
    quotaResetTime = new Date();
    quotaResetTime.setDate(quotaResetTime.getDate() + 1); // Set next reset to tomorrow
    quotaResetTime.setHours(8, 0, 0, 0); // 8 AM
    saveQuotaData();

    console.log(`🔄 [QUOTA] Manual quota reset: ${oldUsed} → 0`);

    res.json({
        success: true,
        message: `Quota manually reset from ${oldUsed} to 0`,
        quota: {
            used: dailyQuotaUsed,
            remaining: getRemainingQuota(),
            total: 10000,
            percentage: 0,
            resetTime: quotaResetTime.toISOString()
        }
    });
});

// PageToken management endpoints
router.get('/pagetokens/:query/:type', async (req, res) => {
    try {
        const { query, type } = req.params;
        const tokens = await PageToken.find({ query, searchType: type }).sort({ page: 1 });

        res.json({
            success: true,
            query,
            searchType: type,
            tokens: tokens.map(t => ({
                page: t.page,
                hasToken: !!t.pageToken,
                hasNext: !!t.nextPageToken,
                createdAt: t.createdAt,
                lastAccessed: t.lastAccessed
            })),
            totalPages: tokens.length
        });
    } catch (error) {
        console.error('Error fetching pageTokens:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/pagetokens/:query/:type', async (req, res) => {
    try {
        const { query, type } = req.params;
        const result = await PageToken.deleteMany({ query, searchType: type });

        console.log(`🗑️ [PAGETOKEN] Deleted ${result.deletedCount} pageTokens for ${type} "${query}"`);

        res.json({
            success: true,
            message: `Deleted ${result.deletedCount} pageTokens for ${type} search "${query}"`,
            deletedCount: result.deletedCount
        });
    } catch (error) {
        console.error('Error deleting pageTokens:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/clear-cache', (req, res) => {
    const clearedKeys = youtubeCache.keys().length;
    youtubeCache.flushAll();
    res.json({
        success: true,
        message: `Cleared ${clearedKeys} cached items`,
        clearedKeys
    });
});

router.get('/cache-info', (req, res) => {
    const keys = youtubeCache.keys();
    const cacheInfo = {
        totalKeys: keys.length,
        keys: keys.map(key => ({
            key,
            ttl: youtubeCache.getTtl(key) ? new Date(youtubeCache.getTtl(key)).toISOString() : null
        })),
        stats: youtubeCache.getStats()
    };

    res.json(cacheInfo);
});

// Admin endpoint to backfill duration data for existing playlist videos
router.post('/playlists-backfill-duration', async (req, res) => {
    try {
        console.log('🔄 [BACKFILL] This endpoint is deprecated. Use client-side backfill instead.');
        console.log('🔄 [BACKFILL] Go to your browser console and run: backfillPlaylistDurations()');

        res.json({
            success: false,
            message: 'Server-side backfill is deprecated. Use client-side backfill function instead.',
            instruction: 'Run backfillPlaylistDurations() in browser console'
        });
    } catch (error) {
        console.error('❌ [BACKFILL] Error:', error);
        res.status(500).json({ error: 'Backfill failed' });
    }
});

// New endpoint for client to send cached video data for backfill
router.post('/playlists-update-durations', async (req, res) => {
    try {
        const { updates } = req.body;
        if (!updates || !Array.isArray(updates)) {
            return res.status(400).json({ error: 'Invalid updates data' });
        }

        const Playlist = require('../models/Playlist');
        let totalUpdated = 0;

        console.log(`🔄 [BACKFILL] Processing ${updates.length} video updates from client cache`);

        for (const update of updates) {
            const { playlistId, videoId, duration, channelTitle } = update;

            if (!playlistId || !videoId) continue;

            const result = await Playlist.updateOne(
                {
                    '_id': playlistId,
                    'videos.videoId': videoId
                },
                {
                    $set: {
                        'videos.$.duration': duration || '',
                        'videos.$.channelTitle': channelTitle || ''
                    }
                }
            );

            if (result.modifiedCount > 0) {
                totalUpdated++;
                console.log(`✅ [BACKFILL] Updated ${videoId}: ${duration}`);
            }
        }

        console.log(`🎯 [BACKFILL] Updated ${totalUpdated}/${updates.length} videos with duration data`);

        res.json({
            success: true,
            totalUpdated,
            totalProcessed: updates.length
        });
    } catch (error) {
        console.error('❌ [BACKFILL] Error:', error);
        res.status(500).json({ error: 'Backfill update failed' });
    }
});

// =====================================================
// EARLY ROUTES (restore-cache, GET search, persistence)
// =====================================================
router.get('/restore-cache/:query', async (req, res) => {
    try {
        const { query } = req.params;
        console.log(`🔍 [RESTORE] Looking for cached results for: "${query}"`);

        const savedSearch = await findBestYouTubeSearchCache(query);

        if (!savedSearch || !savedSearch.videoResults || savedSearch.videoResults.length === 0) {
            return res.json({ success: false, message: 'No cached results found for this query' });
        }

        // Refuse to hydrate a different search's pages into this query's cache
        // (e.g. Privettriker's 20 pages must not become PrivettrickerRevival's total).
        if (
            !youtubeQueriesLooselyEqualServer(query, savedSearch.query) &&
            !youtubeQueriesLooselyEqualServer(query, savedSearch.displayName)
        ) {
            console.warn(
                `[RESTORE] Refusing mismatched cache: asked "${query}" got "${savedSearch.query}"`
            );
            return res.json({ success: false, message: 'No cached results found for this query' });
        }

        // Restore to localStorage format and return
        const restoredPages = savedSearch.videoResults.map(result => ({
            page: result.page,
            videos: result.videos,
            resultType: result.resultType,
            nextPageToken: result.nextPageToken,
            timestamp: result.timestamp
        }));

        console.log(`✅ [RESTORE] Found ${savedSearch.videoResults.length} cached pages for "${query}" (db query: "${savedSearch.query}")`);

        // Return the first page of videos for immediate display
        const firstPage = savedSearch.videoResults.find(result => result.page === 1);
        const videos = firstPage ? firstPage.videos : savedSearch.videoResults[0]?.videos || [];

        res.json({
            success: true,
            query: savedSearch.query || query,
            displayName: savedSearch.displayName || query,
            videos: videos,
            pages: restoredPages,
            totalPages: savedSearch.videoResults.length
        });

    } catch (error) {
        console.error('❌ [RESTORE] Error restoring cache:', error);
        res.status(500).json({ success: false, message: 'Error restoring cache from database' });
    }
});

// YouTube Search Route
router.get('/search', async (req, res) => {
    const { q: query, page = 1 } = req.query;

    if (!query) {
        return res.status(400).json({ success: false, message: 'Search query is required' });
    }

    try {
        console.log(chalk.blue(`[YOUTUBE-API] Searching for: "${query}" on page ${page}`));

        let pageToken = null;
        // To get to page N, we need to fetch pages 1 through N-1 to get the correct pageToken.
        if (page > 1) {
            console.log(chalk.cyan(`[YOUTUBE-API] Fast-forwarding to page ${page}...`));
            let currentPage = 1;
            let response = await youtubeSearchList({ part: 'snippet', q: query, type: 'video', maxResults: 12 });

            while (currentPage < page && response.data.nextPageToken) {
                pageToken = response.data.nextPageToken;
                response = await youtubeSearchList({ part: 'snippet', q: query, type: 'video', maxResults: 12, pageToken });
                currentPage++;
            }
            console.log(chalk.cyan(`[YOUTUBE-API] Reached target page. Using pageToken: ${pageToken}`));
        }

        const searchResponse = await youtubeSearchList({
            part: 'snippet',
            q: query,
            type: 'video',
            maxResults: 12,
            pageToken: pageToken
        });

        if (!searchResponse.data.items || searchResponse.data.items.length === 0) {
            return res.json({ success: true, videos: [], totalPages: 0 });
        }

        const videoIds = searchResponse.data.items.map(item => item.id.videoId).join(',');

        const videoResponse = await youtube.videos.list({
            part: 'snippet,contentDetails,statistics',
            id: videoIds
        });

        const videos = videoResponse.data.items.map(item => ({
            id: item.id,
            title: item.snippet.title,
            thumbnail: item.snippet.thumbnails.high.url,
            channel: item.snippet.channelTitle,
            channelTitle: item.snippet.channelTitle,
            channelId: item.snippet.channelId || '',
            views: item.statistics.viewCount,
            duration: item.contentDetails.duration,
            publishedAt: item.snippet.publishedAt
        }));

        const totalResults = searchResponse.data.pageInfo.totalResults;
        const totalPages = Math.ceil(totalResults / 12);

        res.json({
            success: true,
            videos,
            totalPages
        });

    } catch (error) {
        console.error(chalk.red('[YOUTUBE-API] Error:'), error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch YouTube search results.' });
    }
});

router.post('/save-search', requireDataScope, async (req, res) => {
    try {
        let { query, displayName, totalPages, videoCount, cacheKeys, searchMetadata, videoResults } = req.body;
        const userId = req.scopeKey;

        // Normalize query for internal storage; always strip voice/UI prefixes from displayName
        const stripYouTubePrefix = (q) =>
            String(q || '')
                .replace(/^(?:youtube\s+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)\s+/i, '')
                .trim();
        const normalizeQuery = (q) => {
            return stripYouTubePrefix(q)
                .normalize('NFD')
                .replace(/\p{M}/gu, '')
                .toLowerCase()
                .trim()
                .replace(/\s+/g, '.') // Replace spaces with dots
                .replace(/[^a-z0-9.]/g, '') // Remove special characters except dots
                .replace(/\.+/g, '.') // Replace multiple dots with single dot
                .replace(/^\.+|\.+$/g, ''); // Remove leading/trailing dots
        };

        const originalQuery = (query || '').trim();
        query = normalizeQuery(originalQuery);

        // Prefer cleaned subject over raw "Youtube Seach …" display names;
        // never keep a vowel-stripped label ("Sigur Rs") when a fuller one exists.
        displayName = preferYouTubeDisplayNameServer(
            stripYouTubePrefix(displayName || originalQuery),
            stripYouTubePrefix(originalQuery),
            query.replace(/\./g, ' ').replace(/\b\w/g, l => l.toUpperCase())
        );

        console.log('💾 [YOUTUBE-DB] Explicit SAVE search:', { query, userId, displayName });

        // Prefer fullest existing cache (handles legacy query keys). Every lookup
        // is confined to this account: matching on the query alone would reuse —
        // and then overwrite — another user's saved search.
        let existingSearch =
            (await findBestYouTubeSearchCache(originalQuery, userId)) ||
            (await YouTubeSearch.findOne({ userId, query }));

        if (existingSearch) {
            existingSearch.lastSearched = new Date();
            existingSearch.isSaved = true;
            existingSearch.userId = userId;
            existingSearch.query = query || existingSearch.query;
            existingSearch.displayName = preferYouTubeDisplayNameServer(
                displayName,
                existingSearch.displayName
            );
            existingSearch.cacheKeys = cacheKeys || existingSearch.cacheKeys;
            existingSearch.searchMetadata = { ...existingSearch.searchMetadata, ...searchMetadata };
            if (Array.isArray(videoResults) && videoResults.length) {
                existingSearch.videoResults = mergeYouTubeVideoResults(
                    existingSearch.videoResults,
                    videoResults
                );
            }
            existingSearch.totalPages = Math.max(
                Number(totalPages) || 0,
                existingSearch.videoResults?.length || 0,
                Number(existingSearch.totalPages) || 0
            );
            existingSearch.videoCount =
                (existingSearch.videoResults || []).reduce(
                    (n, p) => n + (p.videos?.length || 0),
                    0
                ) || videoCount || existingSearch.videoCount;
            await existingSearch.save();

            console.log('💾 [YOUTUBE-DB] Marked existing search as saved:', existingSearch._id, 'pages:', existingSearch.videoResults?.length);
            res.json({ success: true, message: 'Search saved', search: existingSearch });
        } else {
            const newSearch = new YouTubeSearch({
                query,
                userId,
                displayName: displayName || query,
                totalPages: totalPages || (videoResults?.length || 1),
                videoCount: videoCount || 0,
                cacheKeys: cacheKeys || [],
                searchMetadata: searchMetadata || {},
                videoResults: Array.isArray(videoResults) ? videoResults : [],
                isSaved: true,
                dateCreated: new Date(),
                lastSearched: new Date()
            });

            await newSearch.save();

            console.log('💾 [YOUTUBE-DB] Saved new search:', newSearch._id);
            res.json({ success: true, message: 'Search saved', search: newSearch });
        }
    } catch (error) {
        console.error('💾 [YOUTUBE-DB] Error saving search:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get YouTube searches (History). Include isSaved so UI can show green LED.
router.get('/saved-searches', requireDataScope, async (req, res) => {
    try {
        const { savedOnly } = req.query;
        const userId = req.scopeKey;

        console.log('📚 [YOUTUBE-DB] Retrieving searches for user:', userId, 'savedOnly:', savedOnly);

        // Owner comes from the token. A ?userId= parameter used to select the
        // bucket, and omitting it returned every account's history.
        const userIds =
            userId === LEGACY_DATA_KEY ? LEGACY_USER_ALIASES : [userId];

        const filter = {
            userId: { $in: userIds },
            ...(savedOnly === 'true' || savedOnly === '1'
                ? { isSaved: { $ne: false } }
                : {}),
        };

        const savedSearches = await YouTubeSearch.find(filter)
            .sort({ lastSearched: -1 });

        console.log('📚 [YOUTUBE-DB] Found', savedSearches.length, 'searches');

        res.json({
            success: true,
            searches: savedSearches.map(search => {
                const cachedPages = Array.isArray(search.videoResults)
                    ? search.videoResults.length
                    : 0;
                const storedPages = Number(search.totalPages) || 0;
                return {
                    _id: search._id,
                    query: search.query,
                    displayName: (() => {
                        const hints = (Array.isArray(search.videoResults) ? search.videoResults : [])
                            .flatMap((p) => (p.videos || []).slice(0, 4).map((v) => v.title || ''))
                            .filter(Boolean)
                            .slice(0, 16);
                        // Repair legacy labels before the client renders History
                        let name = String(search.displayName || search.query || '')
                            .replace(/^[@＠]+/gu, '')
                            .replace(/[:;,.!?…]+$/gu, '')
                            .replace(/^(?:youtube\s+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)\s+/i, '')
                            .trim();
                        const skel = youtubeConsonantSkeletonServer(name);
                        for (const title of hints) {
                            const head = String(title || '')
                                .replace(/^@+/g, '')
                                .split(/\s+[-\u2013|:]+|\s+[(\[]/)[0]
                                ?.trim();
                            if (!head) continue;
                            if (skel && youtubeConsonantSkeletonServer(head) === skel) {
                                const words = name.split(/\s+/).length || 1;
                                const repaired = head.split(/\s+/).slice(0, words).join(' ');
                                name = preferYouTubeDisplayNameServer(name, repaired);
                                break;
                            }
                        }
                        if (name && name === name.toLowerCase()) {
                            name = name.replace(/\b[a-z]/g, (c) => c.toUpperCase());
                        }
                        return name || search.displayName;
                    })(),
                    totalPages: Math.max(cachedPages, storedPages) || search.totalPages || 1,
                    videoCount: search.videoCount,
                    lastSearched: search.lastSearched,
                    dateCreated: search.dateCreated,
                    searchMetadata: search.searchMetadata,
                    isSaved: search.isSaved !== false,
                    hasCachedPages: cachedPages > 0,
                    // Lightweight titles so the client can repair "Sigur Rs" → "Sigur Rós"
                    titleHints: (Array.isArray(search.videoResults) ? search.videoResults : [])
                        .flatMap((p) => (p.videos || []).slice(0, 4).map((v) => v.title || ''))
                        .filter(Boolean)
                        .slice(0, 16),
                };
            })
        });
    } catch (error) {
        console.error('📚 [YOUTUBE-DB] Error retrieving searches:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Remove cached videos whose thumbnails are unreachable (private/deleted)
router.post('/cleanup-inaccessible', async (req, res) => {
    try {
        const https = require('https');
        const http = require('http');
        const q = String(req.body?.query || req.query?.query || '').trim();

        const headOk = (url) =>
            new Promise((resolve) => {
                if (!url || typeof url !== 'string') return resolve(false);
                const lib = url.startsWith('https') ? https : http;
                const request = lib.request(url, { method: 'HEAD', timeout: 8000 }, (r) => {
                    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
                        headOk(r.headers.location).then(resolve);
                        return;
                    }
                    resolve(r.statusCode >= 200 && r.statusCode < 400);
                });
                request.on('error', () => resolve(false));
                request.on('timeout', () => {
                    request.destroy();
                    resolve(false);
                });
                request.end();
            });

        const thumbReachable = async (video) => {
            const id = video?.id;
            const urls = [
                video?.thumbnail,
                id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null,
                id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null,
            ].filter(Boolean);
            for (const u of urls) {
                if (await headOk(u)) return true;
            }
            return false;
        };

        const filter = q
            ? {
                $or: [
                    { query: new RegExp(q.replace(/\s+/g, '.*'), 'i') },
                    { displayName: new RegExp(q.replace(/\s+/g, '\\s*'), 'i') },
                ],
            }
            : {};

        console.log('🧹 [YOUTUBE-DB] Cleanup inaccessible thumbs', q || '(all)');
        const docs = await YouTubeSearch.find(filter);
        let removedTotal = 0;
        let updatedDocs = 0;

        for (const doc of docs) {
            let changed = false;
            const pages = Array.isArray(doc.videoResults) ? doc.videoResults : [];
            for (const page of pages) {
                const before = (page.videos || []).length;
                const kept = [];
                for (const v of page.videos || []) {
                    if (await thumbReachable(v)) kept.push(v);
                    else {
                        removedTotal++;
                        console.log(
                            '  drop',
                            doc.query,
                            `p${page.page}`,
                            v.id,
                            String(v.title || '').slice(0, 40)
                        );
                    }
                }
                if (kept.length !== before) {
                    page.videos = kept;
                    page.totalResults = kept.length;
                    changed = true;
                }
            }
            if (changed) {
                updatedDocs++;
                doc.videoCount = pages.reduce((n, p) => n + (p.videos || []).length, 0);
                doc.totalPages = pages.length;
                doc.markModified('videoResults');
                await doc.save();
            }
        }

        res.json({
            success: true,
            matched: docs.length,
            updatedDocs,
            removedTotal,
        });
    } catch (error) {
        console.error('🧹 [YOUTUBE-DB] Cleanup failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete OR un-save a YouTube search
router.delete('/saved-searches/:searchId', requireDataScope, async (req, res) => {
    try {
        const { searchId } = req.params;
        const { unsaveOnly } = req.query;
        const userId = req.scopeKey;

        console.log('🗑️ [YOUTUBE-DB] Delete/unsave search:', searchId, 'for user:', userId, 'unsaveOnly:', unsaveOnly);

        // Scoped lookup: an id alone would let any caller delete any account's search
        const owners = userId === LEGACY_DATA_KEY ? LEGACY_USER_ALIASES : [userId];
        const doc = await YouTubeSearch.findOne({ _id: searchId, userId: { $in: owners } });
        if (!doc) {
            return res.status(404).json({ success: false, error: 'Search not found' });
        }

        // Unsave only when explicitly requested — keep videoResults for quota cache
        if (unsaveOnly === 'true' || unsaveOnly === '1') {
            doc.isSaved = false;
            await doc.save();
            console.log('🗑️ [YOUTUBE-DB] Unsaved (kept cache pages):', doc.query);
            return res.json({ success: true, message: 'Search unsaved', unsaved: true, search: doc });
        }

        // Hard delete — gone from MongoDB (listing + cached pages)
        await YouTubeSearch.deleteOne({ _id: doc._id });
        console.log('🗑️ [YOUTUBE-DB] Deleted search:', doc.query);
        res.json({ success: true, message: 'Search deleted', deleted: true });
    } catch (error) {
        console.error('🗑️ [YOUTUBE-DB] Error deleting search:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Check if a query is saved in database
router.post('/check-saved', requireDataScope, async (req, res) => {
    try {
        let { queries } = req.body;
        const userId = req.scopeKey;
        queries = (queries || []).map(q => (q || '').trim().toLowerCase());
        console.log('🔍 [YOUTUBE-DB] Checking saved status for', queries.length, 'queries for user:', userId);

        // Use the Mongoose model to find saved queries for this user
        const savedQueries = await YouTubeSearch.find({
            userId,
            query: { $in: queries }
        }).select('query');

        const savedQuerySet = new Set(savedQueries.map(s => s.query));
        const results = {};
        queries.forEach(query => {
            results[query] = savedQuerySet.has(query);
        });
        res.json({ success: true, results });
    } catch (error) {
        console.error('🔍 [YOUTUBE-DB] Error checking saved status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
