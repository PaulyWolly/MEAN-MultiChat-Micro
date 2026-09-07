/*
  YOUTUBEHISTORY.ROUTES.JS
  Version: 2.0
  AppName: MultiChat_Chatty [v2.0]
  Updated: 12/31/2025 @10:00AM
  Created by Paul Welby
*/

const express = require('express');
const router = express.Router();
const YouTubeSearch = require('../models/YouTubeSearch');
const { requireDataScope } = require('../middleware/auth');

// Search history is per-account. Every handler below reads req.scopeKey, which
// is derived from the caller's token, so no request can name another owner.
router.use(requireDataScope);

/** Shape a stored search for the client. */
function toSummary(item) {
    return {
        query: item.query,
        displayName: item.displayName,
        searchType: item.searchMetadata?.searchType || 'search',
        timestamp: item.lastSearched || item.dateCreated,
        totalPages: item.totalPages,
        videoCount: item.videoCount,
        cacheKeys: item.cacheKeys || []
    };
}

/** This caller's searches, newest first. */
async function listForCaller(req) {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
        console.log('📚 [API] MongoDB not connected, returning empty array');
        return null;
    }
    const rows = await YouTubeSearch.find({ userId: req.scopeKey }).sort({ lastSearched: -1 });
    console.log(`📚 [API] Found ${rows.length} searches for ${req.scopeKey}`);
    return rows.map(toSummary);
}

// GET all queries (for cache restoration) - FRONTEND CALLS THIS!
router.get('/list', async (req, res) => {
    try {
        const queries = await listForCaller(req);
        res.json({ queries: queries || [] }); // Frontend expects { queries: [...] }
    } catch (error) {
        console.error('📚 [API] Error loading queries:', error);
        res.status(500).json({ message: error.message });
    }
});

// GET all queries (for cache restoration) - ALTERNATIVE ENDPOINT
router.get('/all', async (req, res) => {
    try {
        const queries = await listForCaller(req);
        res.json(queries || []);
    } catch (error) {
        console.error('📚 [API] Error loading queries:', error);
        res.status(500).json({ message: error.message });
    }
});

// GET history for a session. The :sessionId segment is retained for existing
// callers but ignored — the owner always comes from the token.
router.get('/:sessionId', async (req, res) => {
    try {
        const queries = await listForCaller(req);
        res.json(queries || []);
    } catch (error) {
        console.error('📚 [API] Error loading queries:', error);
        res.status(500).json({ message: error.message });
    }
});

// POST a new query to the history
router.post('/', async (req, res) => {
    const { query } = req.body;
    if (!query) {
        return res.status(400).json({ message: 'Missing query' });
    }

    try {
        // Normalize query for internal storage
        const normalizeQuery = (q) => {
            return String(q || '')
                .replace(/^(?:youtube\s+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)\s+/i, '')
                .normalize('NFD')
                .replace(/\p{M}/gu, '')
                .toLowerCase()
                .trim()
                .replace(/\s+/g, '.') // Replace spaces with dots
                .replace(/[^a-z0-9.]/g, '') // Remove special characters except dots
                .replace(/\.+/g, '.') // Replace multiple dots with single dot
                .replace(/^\.+|\.+$/g, ''); // Remove leading/trailing dots
        };
        
        const originalQuery = query;
        const normalizedQuery = normalizeQuery(originalQuery);
        const humanReadableDisplay = normalizedQuery.replace(/\./g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        
        // Upsert within this account only — keying on the query alone would let
        // one user's search overwrite another's entry for the same term.
        const result = await YouTubeSearch.findOneAndUpdate(
            { query: normalizedQuery, userId: req.scopeKey },
            { 
                $set: { 
                    lastSearched: new Date(),
                    userId: req.scopeKey,
                    displayName: humanReadableDisplay // Human-readable display name
                } 
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        res.status(201).json(result);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// DELETE a query from the history
router.delete('/:sessionId/:query', async (req, res) => {
    try {
        const { query } = req.params;
        const result = await YouTubeSearch.deleteOne({
            query: decodeURIComponent(query),
            userId: req.scopeKey
        });
        if (result.deletedCount === 0) {
            // It's not an error if we try to delete something that's not in the DB
            // (e.g., it only existed in local cache), so we send success.
            return res.status(200).json({ message: 'Query not found in DB, but operation successful.' });
        }
        res.status(200).json({ message: 'Query deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router; 