/*
  SERVER.JS
  Version: 1.0
  AppName: MEAN-MultiChat
  Updated: 08/18/2026 @10:00AM
  Created by Paul Welby
*/

const fetch = require('node-fetch');

// Required dependencies
const express          = require('express');
const cors             = require('cors');
const dotenv           = require('dotenv');
const path = require('path');
const fs = require('fs');

// Local dev: gitignored .env. Render: set the same keys in Environment (no file).
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// Durable /logs logger — install crash handlers before anything else can throw
const logger = require('./lib/logger');
logger.installProcessHandlers();
logger.info('server.boot', { file: __filename });

// MUST run before mongoose/mongodb load — driver captures dns.resolveSrv at import time
const { installMongoDnsFallback, resolveMongoUri } = require('./mongoDnsFallback');
installMongoDnsFallback();

const { MongoClient }  = require('mongodb');
const sdk              = require('microsoft-cognitiveservices-speech-sdk');
const OpenAI           = require('openai');
const axios            = require('axios');
const mongoose         = require('mongoose');
// const { google }       = require('googleapis'); // media-service
// const NodeCache        = require('node-cache'); // media-service

const chalk = require('chalk');

// Import MongoDB models
// YouTubeSearchResult functionality now consolidated into YouTubeSearch model
// const PageToken = require('./models/PageToken'); // media-service
// Auth + users peeled to backend/services/auth-service (:4801)
// const User = require('./models/User');
// const { resolveAuth0UserFromToken, getAuth0Issuer } = require('./middleware/auth0');
const { authenticateToken, optionalAuth, requireDataScope } = require('./middleware/auth');
const { getAiLimits, logAiLimits } = require('./lib/aiLimits');
const { upstreamHttpsAgent, keepHostWarm } = require('./lib/upstreamAgent');

// Debug log environment variables
console.log('Environment variables loaded:');
console.log(JSON.stringify({
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ? 'Present' : 'Missing',
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT
}, null, 4));

// YouTube client MOVED to media-service (:4805). Monolith no longer requires GOOGLE_API_KEY.
if (!process.env.GOOGLE_API_KEY) {
    console.warn('[BACKEND] GOOGLE_API_KEY not set — OK; YouTube lives on media-service');
}

// Initialize OpenAI with validation
if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set in environment variables');
    process.exit(1);
}

if (!process.env.OPENAI_API_KEY.startsWith('sk-')) {
    console.error('Invalid OPENAI_API_KEY format. Key should start with "sk-"');
    process.exit(1);
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Add debug logging
console.log('OpenAI client initialized with API key:');
console.log(JSON.stringify({
    keyLength: process.env.OPENAI_API_KEY.length,
    keyPrefix: process.env.OPENAI_API_KEY.substring(0, 5) + '...',
    keyValid: process.env.OPENAI_API_KEY.startsWith('sk-')
}, null, 4));

// Initialize Express
const app = express();

// Set the port. PORT wins: hosts such as Render assign one at runtime and fail
// the deploy if we bind anywhere else. config.json only supplies the local default.
const config = require('../config/config');
const port = Number(process.env.PORT) || config.getPort() || 4800;

console.log(chalk.magenta(`[BACKEND] Configured for port ${port} (not listening yet)`));

// Print the caps that are actually in force, so a deployed instance can be
// checked against its env vars from the logs alone.
logAiLimits((...args) => console.log(chalk.magenta(...args)));

// Resolve the speech host up front and keep it resolved. A cold DNS lookup here
// costs seconds of dead air at the start of a spoken reply.
if (process.env.SPEECH_REGION) {
  keepHostWarm(`${process.env.SPEECH_REGION}.tts.speech.microsoft.com`);
}

// For frontend (static file) requests
app.use((req, res, next) => {
  if (
    req.url === '/' ||
    req.url.startsWith('/config') ||
    req.url.endsWith('.js') ||
    req.url.endsWith('.css') ||
    req.url.endsWith('.html')
  ) {
    console.log(chalk.green('[FRONTEND]'), req.method, req.url);
  }
  next();
});

// Configure middleware with increased limits.
// Deployed origins come from CORS_ORIGINS (comma-separated) so the Render
// frontend URL does not have to be baked into the source.
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:4200',
  'http://127.0.0.1:4200',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4800',
];
const CORS_ORIGINS = [
  ...DEFAULT_CORS_ORIGINS,
  ...String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean),
];

app.use(cors({
  origin(origin, callback) {
    // Same-origin and non-browser callers (curl, health checks) send no Origin.
    if (!origin) return callback(null, true);
    if (CORS_ORIGINS.includes(origin.replace(/\/$/, ''))) return callback(null, true);
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb', extended: true}));

// This process is the API for the Angular frontend.

// Playlists + YouTube history MOVED to media-service (gateway → :4805)
// Mount playlist API routes
// const playlistRoutes = require('./routes/playlists.routes');
// const youtubeHistoryRoutes = require('./routes/youtubeHistory.routes.js');
// 
// Mount the routes
// app.use('/api/playlists', playlistRoutes);
// app.use('/api/youtube/history', youtubeHistoryRoutes);
// Claude + conversations peeled to backend/services/chat-service (gateway → :4804)
// app.use('/api/claude', require('./routes/claude.routes'));
// app.use('/api/conversations', require('./routes/chatHistory.routes'));
// Logs peeled to backend/services/platform-service (gateway → :4812)
// app.use('/api/logs', require('./routes/logs.routes'));
// AI status peeled to backend/services/usage-service (gateway → :4811)
// app.use('/api/ai', require('./routes/ai.routes'));
// RAG is sign-in only, matching the UI: /rag is not reachable in guest mode.
// RAG peeled to backend/services/rag-service (gateway routes /api/rag → :4802)
// app.use('/api/rag', authenticateToken, require('./routes/rag.routes'));
// Images peeled to backend/services/images-service (gateway → :4803)
// app.use('/api/images', require('./routes/images.routes'));
// /api/analyze-image also lives on images-service (see routes/analyze-image.routes.js there).

// /api/youtube/* MOVED to media-service (:4805) — restore-cache + GET search
// API endpoint to restore cache from MongoDB
// app.get('/api/youtube/restore-cache/:query', async (req, res) => {
//     try {
//         const { query } = req.params;
//         console.log(`🔍 [RESTORE] Looking for cached results for: "${query}"`);
// 
//         const savedSearch = await findBestYouTubeSearchCache(query);
// 
//         if (!savedSearch || !savedSearch.videoResults || savedSearch.videoResults.length === 0) {
//             return res.json({ success: false, message: 'No cached results found for this query' });
//         }
// 
//         // Refuse to hydrate a different search's pages into this query's cache
//         // (e.g. Privettriker's 20 pages must not become PrivettrickerRevival's total).
//         if (
//             !youtubeQueriesLooselyEqualServer(query, savedSearch.query) &&
//             !youtubeQueriesLooselyEqualServer(query, savedSearch.displayName)
//         ) {
//             console.warn(
//                 `[RESTORE] Refusing mismatched cache: asked "${query}" got "${savedSearch.query}"`
//             );
//             return res.json({ success: false, message: 'No cached results found for this query' });
//         }
// 
//         // Restore to localStorage format and return
//         const restoredPages = savedSearch.videoResults.map(result => ({
//             page: result.page,
//             videos: result.videos,
//             resultType: result.resultType,
//             nextPageToken: result.nextPageToken,
//             timestamp: result.timestamp
//         }));
// 
//         console.log(`✅ [RESTORE] Found ${savedSearch.videoResults.length} cached pages for "${query}" (db query: "${savedSearch.query}")`);
// 
//         // Return the first page of videos for immediate display
//         const firstPage = savedSearch.videoResults.find(result => result.page === 1);
//         const videos = firstPage ? firstPage.videos : savedSearch.videoResults[0]?.videos || [];
// 
//         res.json({
//             success: true,
//             query: savedSearch.query || query,
//             displayName: savedSearch.displayName || query,
//             videos: videos,
//             pages: restoredPages,
//             totalPages: savedSearch.videoResults.length
//         });
// 
//     } catch (error) {
//         console.error('❌ [RESTORE] Error restoring cache:', error);
//         res.status(500).json({ success: false, message: 'Error restoring cache from database' });
//     }
// });
// 
// YouTube Search Route
// app.get('/api/youtube/search', async (req, res) => {
//     const { q: query, page = 1 } = req.query;
// 
//     if (!query) {
//         return res.status(400).json({ success: false, message: 'Search query is required' });
//     }
// 
//     try {
//         console.log(chalk.blue(`[YOUTUBE-API] Searching for: "${query}" on page ${page}`));
// 
//         let pageToken = null;
//         // To get to page N, we need to fetch pages 1 through N-1 to get the correct pageToken.
//         if (page > 1) {
//             console.log(chalk.cyan(`[YOUTUBE-API] Fast-forwarding to page ${page}...`));
//             let currentPage = 1;
//             let response = await youtubeSearchList({ part: 'snippet', q: query, type: 'video', maxResults: 12 });
// 
//             while (currentPage < page && response.data.nextPageToken) {
//                 pageToken = response.data.nextPageToken;
//                 response = await youtubeSearchList({ part: 'snippet', q: query, type: 'video', maxResults: 12, pageToken });
//                 currentPage++;
//             }
//             console.log(chalk.cyan(`[YOUTUBE-API] Reached target page. Using pageToken: ${pageToken}`));
//         }
// 
//         const searchResponse = await youtubeSearchList({
//             part: 'snippet',
//             q: query,
//             type: 'video',
//             maxResults: 12,
//             pageToken: pageToken
//         });
// 
//         if (!searchResponse.data.items || searchResponse.data.items.length === 0) {
//             return res.json({ success: true, videos: [], totalPages: 0 });
//         }
// 
//         const videoIds = searchResponse.data.items.map(item => item.id.videoId).join(',');
// 
//         const videoResponse = await youtube.videos.list({
//             part: 'snippet,contentDetails,statistics',
//             id: videoIds
//         });
// 
//         const videos = videoResponse.data.items.map(item => ({
//             id: item.id,
//             title: item.snippet.title,
//             thumbnail: item.snippet.thumbnails.high.url,
//             channel: item.snippet.channelTitle,
//             channelTitle: item.snippet.channelTitle,
//             channelId: item.snippet.channelId || '',
//             views: item.statistics.viewCount,
//             duration: item.contentDetails.duration,
//             publishedAt: item.snippet.publishedAt
//         }));
// 
//         const totalResults = searchResponse.data.pageInfo.totalResults;
//         const totalPages = Math.ceil(totalResults / 12);
// 
//         res.json({
//             success: true,
//             videos,
//             totalPages
//         });
// 
//     } catch (error) {
//         console.error(chalk.red('[YOUTUBE-API] Error:'), error.message);
//         res.status(500).json({ success: false, message: 'Failed to fetch YouTube search results.' });
//     }
// });
// 
// =====================================================
// AUTH + USERS — peeled to backend/services/auth-service (:4801)
// Gateway proxies /api/auth and /api/users there. middleware/auth.js
// stays here so remaining monolith routes can still verify JWTs.
// =====================================================

/** Existing single-user Multichat docs live under these keys. */
const LEGACY_DATA_KEY = 'global-persistent-storage-001-v1';
const LEGACY_USER_ALIASES = ['default-user', LEGACY_DATA_KEY];
/** Shared guest session — profile writes are not allowed. */
const GUEST_DATA_KEY = 'guest-local-v1';

// /api/events peeled to backend/services/platform-service (:4812)
// =====================================================
// SERVER-SENT EVENTS (SSE) — MOVED
// =====================================================
// let clients = [];
//
// function sendToAllClients(data) {
//   clients.forEach(client => client.res.write(`data: ${JSON.stringify(data)}\n\n`));
// }
//
// app.get('/api/events', (req, res) => {
//   res.setHeader('Content-Type', 'text/event-stream');
//   res.setHeader('Cache-Control', 'no-cache');
//   res.setHeader('Connection', 'keep-alive');
//   res.flushHeaders();
//
//   const clientId = Date.now();
//   const newClient = {
//     id: clientId,
//     res: res
//   };
//   clients.push(newClient);
//   console.log(chalk.blue(`[SSE] Client connected: ${clientId}`));
//
//   req.on('close', () => {
//     clients = clients.filter(client => client.id !== clientId);
//     console.log(chalk.yellow(`[SSE] Client disconnected: ${clientId}`));
//   });
// });

console.log(chalk.magenta('Starting server initialization...'));
console.log(chalk.magenta('Serving config from:'), chalk.magenta(path.join(__dirname, '..', 'config')));

// =====================================================
// UTILITY/HELPER FUNCTIONS
// =====================================================

// TIME RELATED FUNCTIONS

// Format the timestamp
function formatTimestamp(date) {
    return new Intl.DateTimeFormat('en-US', {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'America/Los_Angeles',
        hour12: true
    }).format(date);
}

// PATTERNS for time, date, greetings, and bing search
const chatPatterns = {
    greetings: [
        /^hi$/i,
        /^hello$/i,
        /^hey$/i
    ],
    time: [
        /what(?:'s| is)(?: the)?(?: local)? time/i,
        /what time is it/i,
        /^what time\b/i,
        /tell me(?: the)?(?: local)? time/i,
        /current time/i,
        /do you know what time it is/i,
    ],
    date: [
        /what(?:'s| is)(?: the)?(?: current)? date/i,
        /what day is it/i,
        /tell me(?: the)? date/i,
        /today'?s date/i,
    ],
    dateTime: [
        /date and time/i,
        /time and date/i
    ]
};

// Holiday helper function
function getHoliday(date) {
    const month = date.getMonth() + 1; // JavaScript months are 0-based
    const day = date.getDate();
    const year = date.getFullYear();

    console.log('Checking holiday for:', { month, day, year });

    // Calculate Thanksgiving (4th Thursday of November)
    if (month === 11) {  // November
        console.log('November detected, calculating Thanksgiving...');

        const thanksgiving = new Date(year, 10, 1);  // Start with November 1
        console.log('Starting with:', thanksgiving.toDateString());

        // Find first Thursday
        while (thanksgiving.getDay() !== 4) {
            thanksgiving.setDate(thanksgiving.getDate() + 1);
        }
        console.log('First Thursday:', thanksgiving.toDateString());

        // Add 3 weeks to get to 4th Thursday
        thanksgiving.setDate(thanksgiving.getDate() + 21);
        console.log('Fourth Thursday:', thanksgiving.toDateString());

        console.log('Detailed comparison:', {
            thanksgivingDate: thanksgiving.getDate(),
            currentDay: day,
            thanksgivingMonth: thanksgiving.getMonth() + 1,
            currentMonth: month,
            thanksgivingYear: thanksgiving.getFullYear(),
            currentYear: year,
            isExactMatch: day === thanksgiving.getDate() && month === (thanksgiving.getMonth() + 1)
        });

        if (day === thanksgiving.getDate()) {
            console.log('MATCH FOUND - Returning Thanksgiving greeting');
            return {
                name: "Thanksgiving Day",
                greeting: "Happy Thanksgiving!"
            };
        } else {
            console.log('No match - Thanksgiving date differs');
        }
    }

    // Rest of the holiday checks...
    const holidays = {
        "1/1": "New Year's Day",
        "7/4": "Independence Day",
        "12/24": "Christmas Eve",
        "12/25": "Christmas Day",
        "12/31": "New Year's Eve"
    };

    const dateKey = `${month}/${day}`;
    console.log('Checking fixed holiday dateKey:', dateKey);

    if (holidays[dateKey]) {
        console.log('Found fixed holiday:', holidays[dateKey]);
        return {
            name: holidays[dateKey],
            greeting: `Happy ${holidays[dateKey]}!`
        };
    }

    console.log('No holiday found for this date');
    return null;
}

// Format the time and date strings
function formatTimeDateStr(date, timezone = 'America/Los_Angeles') {
    return {
        timeStr: date.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: timezone
        }),

        dateStr: date.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: timezone
        })
    };
}

// Get the time of day
function getTimeOfDay(timezone = 'America/Los_Angeles') {
    const hour = new Date().toLocaleString('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone: timezone
    });

    const hourNum = parseInt(hour);

    if (hourNum >= 5 && hourNum < 12) {
        return 'morning';
    } else if (hourNum >= 12 && hourNum < 17) {
        return 'afternoon';
    } else {
        return 'evening';
    }
}

// Format the minutes plural
function formatMinutesPlural(minutes) {
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
// =====================================================
// LOGGING FUNCTIONS
// =====================================================

// Update the logging middleware
app.use((req, res, next) => {
    const timestamp = formatTimestamp(new Date());
    console.log('\n━━━━━━ New Request ━━━━━━━━━━━');
    console.log(`Timestamp: ${timestamp}`);
    console.log(`Endpoint: ${req.path}`);
    console.log(`Method: ${req.method}`);
    if (req.method === 'POST' && Object.keys(req.body).length > 0) {
        console.log('Request Body:', req.body);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Capture response metadata
    const oldWrite = res.write;
    const oldEnd = res.end;

    res.write = function(chunk, ...args) {
        if (chunk && !res.writableEnded) {
            try {
                const data = JSON.parse(chunk.toString().replace('data: ', ''));
                if (data.metrics) {
                    console.log('\n━━━━━━━━━━━ Response Metrics ━━━━━━━━━━━');
                    console.log(`Time: ${formatTimestamp(new Date())}`);
                    console.log('Duration:', data.metrics.duration || 'In progress');
                    console.log('Prompt Tokens:', data.metrics.promptTokens || 0);
                    console.log('Completion Tokens:', data.metrics.completionTokens || 0);
                    console.log('Total Tokens:', data.metrics.totalTokens || 0);
                    console.log('Model:', data.metrics.model || 'Unknown');
                    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
                }
            } catch (e) {
                // Not JSON or not metrics data
            }
            return oldWrite.apply(res, [chunk, ...args]);
        }

    };

    res.end = function(...args) {
        if (!res.writableEnded) {
            const timestamp = formatTimestamp(new Date());
            console.log('\n━━━━━━━━━━━ Response ━━━━━━━━━━━');
            console.log(`Status: ${res.statusCode}`);
            console.log(`Time: ${timestamp}`);
            if (res.get('Content-Type')?.includes('text/event-stream')) {
                console.log('Response: [SSE Stream]');
            }
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            return oldEnd.apply(res, args);
        }
    };

    next();
});


// =====================================================
// ROUTES
// =====================================================


// /api/auth/token → auth-service :4801 (playlist JWT helper)

// Aggregate all typed facts for a session from conversation_history
// Personal-info / profile moved to backend/services/profile-service (gateway → :4809)
// app.get/post('/api/personal-info'…) live there now. See routes/personal-info.routes.js stub.


app.get('/', (req, res) => {
    res.json({ service: 'mern-multichat-api', status: 'ok' });
});

// Azure TTS / voices moved to backend/services/speech-service (gateway → :4806)
// app.get('/api/voices', ...) and app.post('/api/tts', optionalAuth, ...) live there now.

// Chat moved to backend/services/chat-service (gateway /api/chat → :4804)
// app.get('/api/chat', ...) and app.post('/api/chat', optionalAuth, ...) live there now.

// Image analysis moved to backend/services/images-service (gateway /api/analyze-image → :4803)

// /api/datetime peeled to backend/services/platform-service (:4812)
// app.post('/api/datetime', async (req, res) => { … });


// =====================================================
// JOKE API ENDPOINTS — moved to backend/services/jokes-service (:4807)
// Gateway proxies /api/jokes there. See routes/jokes.routes.js stub.
// =====================================================

// /api/debug/jokes peeled to backend/services/platform-service (:4812)
// =====================================================
// JOKES DEBUG ENDPOINTS — MOVED
// =====================================================
// app.get('/api/debug/jokes', async (req, res) => { … });


// =====================================================
// MODEL HANDLERS
// =====================================================

// === Robust Recipe Formatter ===
function chatTodayLabel() {
    return new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
}

/** Questions that must hit live web search (not training memory). */
function needsLiveWebSearch(message) {
    const t = String(message || '').toLowerCase();
    if (!t.trim()) return false;
    return (
        /\b(who\s+is|who'?s|who\s+was|current|currently|right\s+now|as\s+of|latest|breaking|news|headline)\b/i.test(
            t
        ) ||
        /\b(potus|president|prime\s+minister|governor|mayor|ceo|winner|election|weather|forecast|score|standings|stock|ticker)\b/i.test(
            t
        ) ||
        /\b(today|tonight|this\s+week|this\s+month|this\s+year)\b/i.test(t) ||
        // Prices / FX / “how much is £… in USD”
        /[£$€¥]|gbp|usd|eur|cad|aud|jpy|cny|bitcoin|btc|eth\b/i.test(t) ||
        /\b(exchange\s*rate|convert|conversion|in\s+usd|in\s+dollars|in\s+pounds|in\s+euros|worth\s+in)\b/i.test(
            t
        ) ||
        /\b(how\s+much\s+(?:is|are|would|does|do)|price\s+of|cost\s+of)\b/i.test(t)
    );
}

function didUseOpenAIWebSearch(response) {
    const output = response?.output;
    if (!Array.isArray(output)) return false;
    return output.some((item) => {
        if (!item || typeof item !== 'object') return false;
        if (item.type === 'web_search_call') return true;
        if (item.type !== 'message' || !Array.isArray(item.content)) return false;
        return item.content.some(
            (part) => Array.isArray(part?.annotations) && part.annotations.length > 0
        );
    });
}

function formatRecipeText(text) {
    if (!text) return text;
    // Insert line breaks before Ingredients: and Instructions:
    let processed = text.replace(/(Ingredients:)/i, '\n$1')
                        .replace(/(Instructions:)/i, '\n$1');
    // Convert ALL CAPS title to Title Case if it appears at the start
    processed = processed.replace(/^([A-Z ]{4,})\n/, (match, p1) => {
        return p1.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) + '\n';
    });
    // Fallback: If only one line after splitting, try splitting by period
    let lines = processed.split('\n').map(l => l.trim()).filter(l => l);
    if (lines.length === 1) {
        lines = processed.split('. ').map(l => l.trim()).filter(l => l);
        processed = lines.join('\n');
    }
    return processed;
}

// GPT-4o-mini model handler
async function handleGPT4oMiniResponse(response, res, message, startTime) {
    console.log('Starting GPT-4o-mini response handling');
    let tokenCount = 0;
    let fullResponse = '';
    let currentParagraph = '';
    let lastSentContent = '';
    let isEnded = false;
    let isRecipeRequest = message.toLowerCase().includes('recipe for') || message.toLowerCase().includes('how to make');
    try {
        for await (const chunk of response) {
            if (isEnded) break;
            if (!chunk || !chunk.choices || !Array.isArray(chunk.choices) || chunk.choices.length === 0) {
                continue;
            }
            if (chunk.choices[0]?.delta?.content) {
                const content = chunk.choices[0].delta.content;
                fullResponse += content;
                currentParagraph += content;
                tokenCount += Math.ceil(content.length / 4);
                if (content.includes('[/P1]') || content.includes('[/P2]') || content.includes('[/P3]') || content.includes('[/IMG]') || content.includes('\n\n')) {
                    let cleanParagraph = currentParagraph.replace(/\[P1\]|\[P2\]|\[P3\]|\[IMG\]|\[\/P1\]|\[\/P2\]|\[\/P3\]|\[\/IMG\]/g, '').trim();
                    if (cleanParagraph && cleanParagraph !== lastSentContent) {
                        // If this is a recipe, format it before sending
                        if (isRecipeRequest) {
                            cleanParagraph = formatRecipeText(cleanParagraph);
                        }
                        if (!res.writableEnded) {
                            res.write(`data: ${JSON.stringify({
                                response: cleanParagraph + '\n\n',
                                tokenCount: tokenCount,
                                metrics: {
                                    duration: Date.now() - startTime,
                                    promptTokens: Math.ceil(fullResponse.length / 4),
                                    completionTokens: tokenCount,
                                    totalTokens: Math.ceil(fullResponse.length / 4) + tokenCount,
                                    model: 'gpt-4o-mini'
                                }
                            })}\n\n`);
                        }
                        lastSentContent = cleanParagraph;
                        currentParagraph = '';
                    }
                }
            }
        }
        // Send any remaining content and final metrics
        if (currentParagraph.trim() && currentParagraph.trim() !== lastSentContent) {
            let toSend = currentParagraph.trim();
            if (isRecipeRequest) {
                toSend = formatRecipeText(toSend);
            }
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({
                    response: toSend,
                    tokenCount: tokenCount,
                    metrics: {
                        duration: Date.now() - startTime,
                        promptTokens: Math.ceil(fullResponse.length / 4),
                        completionTokens: tokenCount,
                        totalTokens: Math.ceil(fullResponse.length / 4) + tokenCount,
                        model: 'gpt-4o-mini'
                    }
                })}\n\n`);
            }
        }
        // Send final completion signal
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({
                done: true,
                complete: true,
                response: null,
                metrics: {
                    duration: Date.now() - startTime,
                    promptTokens: Math.ceil(message.length / 4),
                    completionTokens: tokenCount,
                    totalTokens: Math.ceil(message.length / 4) + tokenCount,
                    model: 'gpt-4o-mini'
                }
            })}\n\n`);
            res.end();
            isEnded = true;
        }
    } catch (error) {
        console.error('Error in handleGPT4oMiniResponse:', error);
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({
                error: error.message,
                done: true,
                complete: true
            })}\n\n`);
            res.end();
        }
        throw error;
    }
}

// Phi-3-mini-4k-instruct model handler


async function handlePhi3Mini4kInstructResponse(completion, res, message, startTime) {
    if (!completion) {
        throw new Error('No completion provided to Phi-3 handler');
    }

    try {
        let tokenCount = 0;
        let fullResponse = '';

        for await (const chunk of completion) {
            if (chunk.choices[0]?.delta?.content) {
                const content = chunk.choices[0].delta.content;
                fullResponse += content;
                tokenCount += Math.ceil(content.length / 4);

                // Send chunk with metrics
                res.write(`data: ${JSON.stringify({
                    response: content,
                    metrics: {
                        duration: Date.now() - startTime,
                        promptTokens: Math.ceil(message.length / 4),
                        completionTokens: tokenCount,
                        totalTokens: Math.ceil(message.length / 4) + tokenCount,
                        model: 'phi-3-mini-4k-instruct'
                    }
                })}\n\n`);
            }
        }

        // Send completion signal
        res.write(`data: ${JSON.stringify({
            done: true,
            metrics: {
                duration: Date.now() - startTime,
                promptTokens: Math.ceil(message.length / 4),
                completionTokens: tokenCount,
                totalTokens: Math.ceil(message.length / 4) + tokenCount,
                model: 'phi-3-mini-4k-instruct'
            }
        })}\n\n`);
        res.end();

    } catch (error) {
        console.error('Error in Phi-3 handler:', error);
        throw error; // Let the main error handler deal with it
    }
}


// =====================================================
// SEARCH ENDPOINTS
// =====================================================

// =====================================================
// GOOGLE IMAGE SEARCH ENDPOINT
// =====================================================

const IMAGE_PROXY_CACHE = new Map();
const IMAGE_PROXY_INFLIGHT = new Map();
// Wikimedia asks for a descriptive UA with a contact URL; bare strings get throttled.
const IMAGE_PROXY_USER_AGENT =
    'MERN-MultiChat/2.0 (https://github.com/PaulyWolly/MERN-MultiChat; image-proxy)';
const OPENVERSE_USER_AGENT =
    'MERN-MultiChat/2.0 (https://github.com/PaulyWolly/MERN-MultiChat; chat image search)';

/**
 * Openverse /thumb/ often 424s (their renderer fails on Wikimedia Jetpack URLs).
 * Prefer a smaller origin URL the browser/proxy can fetch directly.
 */
function preferGridThumbnail(fullUrl) {
    if (!fullUrl || typeof fullUrl !== 'string') return fullUrl || '';
    try {
        const u = new URL(fullUrl);
        // Flickr: …/{id}_{secret}_b.jpg → _n (medium) for the chat grid
        if (u.hostname === 'live.staticflickr.com' || u.hostname.endsWith('.staticflickr.com')) {
            const rewritten = u.pathname.replace(
                /(_[a-f0-9]+)(?:_[a-z])?(\.(?:jpe?g|png|gif|webp))$/i,
                '$1_n$2'
            );
            if (rewritten !== u.pathname) {
                u.pathname = rewritten;
                return u.toString();
            }
        }
        // Commons full file → width-limited thumb (skip if already /thumb/)
        if (
            u.hostname === 'upload.wikimedia.org' &&
            /\/wikipedia\/commons\/[0-9a-f]\/[0-9a-f]{2}\//i.test(u.pathname) &&
            !u.pathname.includes('/thumb/')
        ) {
            const m = u.pathname.match(
                /^(\/wikipedia\/commons\/)([0-9a-f])\/([0-9a-f]{2})\/(.+)$/i
            );
            if (m) {
                const fileName = m[4];
                const isSvg = /\.svg$/i.test(fileName);
                const thumbFile = isSvg
                    ? `500px-${fileName}.png`
                    : `500px-${fileName}`;
                u.pathname = `${m[1]}thumb/${m[2]}/${m[3]}/${fileName}/${thumbFile}`;
                u.search = '';
                return u.toString();
            }
        }
    } catch {
        /* keep full */
    }
    return fullUrl;
}

function isPrivateOrLocalHostname(host) {
    const h = String(host || '').toLowerCase();
    if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
        return true;
    }
    // Literal IPv4
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
        return /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
    }
    return false;
}

/** Allow HTTPS image hosts for proxying (Google full-size often hotlink-blocks the browser). */
function isAllowedImageProxyUrl(urlStr) {
    try {
        const u = new URL(urlStr);
        if (u.protocol !== 'https:') return false;
        if (isPrivateOrLocalHostname(u.hostname)) return false;
        return true;
    } catch {
        return false;
    }
}

async function fetchImageWithRetry(url) {
    const maxAttempts = 3;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const resp = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': IMAGE_PROXY_USER_AGENT,
                    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                    Referer: 'https://www.google.com/'
                },
                timeout: 20000,
                maxRedirects: 5,
                validateStatus: (s) => s >= 200 && s < 400
            });
            return {
                buffer: Buffer.from(resp.data),
                contentType: resp.headers['content-type'] || 'image/jpeg'
            };
        } catch (err) {
            lastError = err;
            const status = err.response?.status;
            if (status !== 429 && status !== 503) throw err;
            if (attempt === maxAttempts) break;
            const retryAfter = Number(err.response?.headers?.['retry-after']);
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter * 1000, 5000)
                : 400 * 2 ** (attempt - 1);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
    }
    throw lastError;
}

async function fetchImageToCache(url) {
    if (IMAGE_PROXY_CACHE.has(url)) {
        return IMAGE_PROXY_CACHE.get(url);
    }
    // Warmup and the browser ask for the same URL at once; without this the
    // upstream sees double the traffic and starts returning 429.
    const inFlight = IMAGE_PROXY_INFLIGHT.get(url);
    if (inFlight) return inFlight;

    const pending = fetchImageWithRetry(url)
        .then(entry => {
            IMAGE_PROXY_CACHE.set(url, entry);
            if (IMAGE_PROXY_CACHE.size > 200) {
                const oldest = IMAGE_PROXY_CACHE.keys().next().value;
                IMAGE_PROXY_CACHE.delete(oldest);
            }
            return entry;
        })
        .finally(() => IMAGE_PROXY_INFLIGHT.delete(url));

    IMAGE_PROXY_INFLIGHT.set(url, pending);
    return pending;
}

/** Serial prefetch avoids Wikimedia 429 when browser loads many images at once */
async function warmupImageCache(images) {
    for (const img of images) {
        const url = img.thumbnail || img.link;
        if (!isAllowedImageProxyUrl(url)) continue;
        try {
            await fetchImageToCache(url);
            await new Promise(resolve => setTimeout(resolve, 120));
        } catch (err) {
            console.warn('[IMAGE PROXY] warmup failed:', url.slice(0, 70), err.message);
        }
    }
}

function toProxyPath(url) {
    const path = `/api/image-proxy?url=${encodeURIComponent(url)}`;
    // Absolute on Render so the static site never requests /api/* on itself
    // (those rewrites fall through to index.html → broken <img>).
    const base = String(
        process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || ''
    ).replace(/\/$/, '');
    return base ? `${base}${path}` : path;
}

/**
 * Serve thumbs + full-size through our proxy so detail modal isn't blocked by
 * hotlink / referrer rules on third-party hosts.
 */
function wrapImagesForProxy(images, { proxyThumbnail = true } = {}) {
    return images.map(img => {
        const full = img.link || img.url || '';
        const thumb = img.thumbnail || img.thumb || full;
        const out = {
            ...img,
            title: img.title,
            originalUrl: full || thumb
        };
        if (proxyThumbnail && thumb && isAllowedImageProxyUrl(thumb)) {
            out.thumbnail = toProxyPath(thumb);
        }
        if (full && isAllowedImageProxyUrl(full)) {
            out.link = toProxyPath(full);
        } else if (out.thumbnail) {
            // Fall back to proxied thumb when full URL can't be proxied
            out.link = out.thumbnail;
        }
        return out;
    });
}

// Image search/proxy peeled to backend/services/media-service (:4805)
// app.get('/api/image-proxy', async (req, res) => { … });

/**
 * Primary image source. Openverse aggregates Flickr, museums and Commons into
 * one openly-licensed index, so it returns far more on-subject results than
 * Commons alone. Free, no API key, and it serves its own thumbnails — which
 * keeps us off the origin hosts that were rate-limiting the proxy.
 */
async function fetchOpenverseImages(searchQuery, start = 1) {
    const limit = 10;
    const page = Math.floor(Math.max(0, start - 1) / limit) + 1;
    const response = await axios.get('https://api.openverse.org/v1/images/', {
        params: {
            q: searchQuery,
            // Must match the caller's step of 10, otherwise "More images" would
            // skip whatever the extra results on each page would have been.
            page_size: limit,
            page,
            mature: false
        },
        headers: { 'User-Agent': OPENVERSE_USER_AGENT },
        timeout: 15000
    });
    return (response.data.results || [])
        .map(item => {
            if (!item?.url) return null;
            // Do NOT use item.thumbnail (api.openverse.org/.../thumb/) — that
            // endpoint frequently returns 424 when upstream is Wikimedia.
            const full = item.url;
            return {
                link: full,
                title: item.title || searchQuery,
                thumbnail: preferGridThumbnail(full),
                contextLink: item.foreign_landing_url || item.url,
                creator: item.creator || undefined,
                license: item.license ? String(item.license).toUpperCase() : undefined,
                attribution: item.attribution || undefined,
                provider: item.source || 'openverse'
            };
        })
        .filter(Boolean)
        .filter(isLikelyUsefulPhoto)
        .slice(0, limit);
}

const CHAT_LEAD_IN = [
    /^(please[,.\s]+)+/i,
    /^(can|could|would|will)\s+you\s+/i,
    /^(show|find|get|search\s+for|look\s+up|give)\s+(?:me\s+)?(?:some\s+|a\s+few\s+)?/i,
    /^(tell|remind)\s+me\s+(?:once\s+more|again|more)?\s*(?:about|of)?\s*/i,
    /^(talk|speak)\s+(?:to\s+me\s+)?(?:once\s+more\s+|again\s+)?about\s+/i,
    /^(explain|describe|discuss)\s+(?:to\s+me\s+)?(?:once\s+more\s+|again\s+)?(?:about\s+)?/i,
    /^(what\s+do\s+you\s+know\s+about)\s+/i,
    /^(what(?:'s|\s+is|\s+are)|who(?:'s|\s+is|\s+are))\s+/i,
    /^(i\s+(?:want|need|would\s+like)(?:\s+to\s+(?:know|hear|learn))?\s+(?:about\s+)?)/i,
    /^(once\s+more|again|more)(?:\s+about)?\s+/i,
    /^(about|of|for|on)\s+(?:the\s+|a\s+|an\s+)?/i,
    /^(the\s+|a\s+|an\s+)/i,
];

function stripChatLeadIn(input) {
    let q = String(input || '').trim();
    for (let n = 0; n < 8; n++) {
        const before = q;
        for (const re of CHAT_LEAD_IN) {
            q = q.replace(re, '').trim();
        }
        if (q === before) break;
    }
    return q;
}

function normalizeImageSearchQuery(query) {
    if (!query || typeof query !== 'string') return '';
    let q = query.trim();
    q = q.replace(/^(?:here are some relevant images (?:of|for)\s*)+/i, '');
    q = q.replace(/^(?:(?:a|an|the)\s+)?(?:recipe\s+for|recipe\s+of)\s+/i, '');
    // Voice: "can I see of the …"
    q = q.replace(
        /^(?:please\s+)?(?:can\s+i|could\s+i|may\s+i|let\s+me|i(?:'d|\s+would)\s+like\s+to)\s+see(?:\s+(?:of|about|for))?\s+/i,
        ''
    );
    // Chat padding ("tell me again about", "please explain", "once more") — not part of the subject.
    q = stripChatLeadIn(q);
    q = q.replace(/^(?:for|of|about)\s+(?:a|an|the)\s+/i, '');
    q = q.replace(/^(?:of|about|for|on)\s+(?:the\s+|a\s+|an\s+)?/i, '');
    // "history of crumb cake" / "origins of X" → subject only (Wikimedia fails on long phrase queries)
    q = q.replace(/^(?:the\s+)?(?:history|origins?|story|background)\s+of\s+(?:the\s+|a\s+|an\s+)?/i, '');
    q = q.replace(/\b(?:the\s+)?(?:history|origins?|story)\s+of\s+(?:the\s+|a\s+|an\s+)?/gi, ' ');
    q = q.replace(/^(?:how\s+to\s+(?:make|bake|cook|prepare)\s+)/i, '');
    q = q.replace(/\s+and\s+how\s+(?:it'?s|they(?:'re|\s+are)|to)\s+\w[\s\S]*$/i, '');
    q = q.replace(/\s+how\s+(?:it'?s|they(?:'re|\s+are))\s+(?:made|prepared|baked)\b[\s\S]*$/i, '');
    q = q.replace(/^(?:a|an|the)\s+/i, '');
    q = q.replace(/\bok(?:ay)?\s+corral\b/gi, 'O.K. Corral');
    q = q.replace(/\brecipe\b/gi, ' ').replace(/\s+/g, ' ').trim();
    q = q.replace(/\s+(?:with\s+)?(?:images?|imges?|imge|pictures?|picturs?|pcture|pctures?|photos?|phots?)\s*$/i, '').trim();
    q = q.replace(/\b(?:and\s+)?(?:provide|show|include|providing)\s+(?:me\s+)?(?:some\s+)?(?:images?|imges?|imge|pictures?|picturs?|pcture|pctures?|photos?)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    q = q.replace(/\b(?:and\s+)?provid(?:e|ing)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    q = stripChatLeadIn(q);
    q = q.replace(/\bok(?:ay)?\s+corral\b/gi, 'O.K. Corral');
    q = q.replace(/\b(blue)\s+(ringed|spotted|striped)\s+(\w+)\b/gi, '$1-$2 $3');
    // AI response paragraph used as query — keep leading subject only
    if (q.length > 60 || /\bis a\b|\bare a\b|\bwas a\b/i.test(q)) {
        const lead = q.match(/^(.{3,80}?)\s+(?:is|are|was|were)\s+(?:a|an|the)\b/i);
        if (lead?.[1]) q = lead[1].trim();
    }
    if (q.length > 80) q = q.slice(0, 80).replace(/\s+\S*$/, '').trim();
    return q || query.trim().slice(0, 80);
}

function isProbablyRecipeQuery(query) {
    return /\b(recipe|cake|cupcake|cookie|pie|bread|soup|salad|stew|pasta|dessert|bake|roast|crum(?:b|ble)|food|dish|drink|cocktail|liqueur|limoncello)\b/i.test(query);
}

function isLikelyUsefulPhoto(img) {
    const text = `${img.title || ''} ${img.link || ''}`.toLowerCase();
    if (/\.pdf|\.djvu|recipe book|cookbook|calibration|chart|guide|manual|encyclopedia/i.test(text)) {
        return false;
    }
    if (/\.(jpe?g|png|webp|gif)(\?|$|\/)/i.test(img.link || '')) return true;
    return !/\bbook\b|\bguide\b/i.test(text);
}

function scoreImageRelevance(img, subject, recipeMode) {
    const text = `${img.title || ''} ${img.link || ''} ${img.contextLink || ''}`.toLowerCase();
    // Drop filler words so "limoncello food" still keys on limoncello.
    // "about" / "again" must not count — they match random titles and let
    // "blue polo" through for "blue ringed octopus".
    const stop = new Set([
        'the', 'and', 'for', 'with', 'recipe', 'food', 'dish', 'photo', 'image',
        'about', 'again', 'more', 'tell', 'please', 'some', 'also', 'just',
        'from', 'this', 'that', 'your', 'into', 'over', 'than', 'then',
        'how', 'its', 'made', 'make', 'bake', 'cooked'
    ]);
    const colors = new Set([
        'red', 'blue', 'green', 'orange', 'yellow', 'pink', 'purple',
        'black', 'white', 'brown', 'gold', 'silver', 'grey', 'gray', 'navy', 'teal'
    ]);
    const terms = subject
        .toLowerCase()
        .replace(/-/g, ' ')
        .split(/\s+/)
        .map((t) => t.replace(/[^a-z0-9]/g, ''))
        .filter((t) => t.length > 2 && !stop.has(t));
    let score = 0;
    let hits = 0;
    for (const term of terms) {
        if (text.includes(term)) {
            score += 3;
            hits += 1;
        }
    }
    // Color words ("orange", "blue") are modifiers, not the subject.
    const distinctive = terms.filter((t) => t.length >= 5 && !colors.has(t));
    const distinctiveHits = distinctive.filter((t) => text.includes(t)).length;
    if (distinctive.length && distinctiveHits === 0) score -= 16;
    const head = [...terms].reverse().find((t) => !colors.has(t));
    if (head && head.length >= 4 && !text.includes(head)) score -= 18;
    if (terms.length >= 3 && hits < 2) score -= 8;
    // Prefer titles that actually name the dish; reject unrelated stock photos.
    if (terms.length && hits === 0) score -= 10;
    if (recipeMode) {
        if (/\b(car|cars|sedan|coupe|vehicle|truck|van|boat|ship|fire|highway|motor|automotive)\b/i.test(text)) {
            score -= 25;
        }
        if (/\b(recipe|dish|drink|cocktail|liqueur|bottle|glass|plate|bowl|cake|cupcake|soup|salad|icing|frosting|snack)\b/i.test(text)) {
            score += 2;
        }
        if (/\bcrumb\b|\bstreusel|\bcoffee cake|\bcrumb cake|\bkuchen\b/i.test(text)) score += 4;
        if (/\bcrab cake\b/i.test(text) && /\bcrumb\b/i.test(subject) && !/\bcrab\b/i.test(subject)) score -= 8;
    }
    return score;
}

/** Keep only images that look like they depict the subject. */
function rankImagesForSubject(images, subject) {
    const recipeMode = isProbablyRecipeQuery(subject) || /\bfood\b/i.test(subject);
    return [...images]
        .map((img) => ({ img, score: scoreImageRelevance(img, subject, recipeMode) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .map(({ img }) => img);
}

/** Fallback when Google CSE key/project mismatch — no API key required */
async function fetchWikimediaCommonsImages(searchQuery, start = 1) {
    const subject = normalizeImageSearchQuery(searchQuery);
    const recipeMode = isProbablyRecipeQuery(subject);
    const limit = 10;
    const offset = Math.max(0, start - 1);
    const wikiQuery = recipeMode
        ? `${subject} food -book -pdf -cookbook`
        : `${subject} -book -pdf -cookbook`;
    const response = await axios.get('https://commons.wikimedia.org/w/api.php', {
        params: {
            action: 'query',
            generator: 'search',
            gsrsearch: wikiQuery,
            gsrlimit: limit + 20,
            gsrnamespace: 6,
            gsroffset: offset,
            prop: 'imageinfo',
            iiprop: 'url',
            iiurlwidth: 400,
            format: 'json'
        },
        headers: { 'User-Agent': 'MultiChat_Chatty/2.0 (local image search)' }
    });
    const pages = response.data.query?.pages || {};
    return Object.values(pages)
        .map(page => {
            const info = page.imageinfo?.[0];
            if (!info?.url) return null;
            return {
                link: info.url,
                title: (page.title || '').replace(/^File:/, '') || subject,
                thumbnail: info.thumburl || info.url,
                contextLink: info.descriptionurl || info.url
            };
        })
        .filter(Boolean)
        .filter(isLikelyUsefulPhoto)
        .sort((a, b) => scoreImageRelevance(b, subject, recipeMode) - scoreImageRelevance(a, subject, recipeMode))
        .slice(0, limit);
}

// Image search — Openverse first, Wikimedia Commons as backup.
// (Google CSE shuts down 2027-01-01 and Bing's API was retired in 2025, so both are gone.)
const imageSearchHandler = async (req, res) => {
    try {
        const rawQuery = req.query.q;
        if (!rawQuery) {
            return res.status(400).json({ error: 'Search query is required' });
        }

        const searchQuery = normalizeImageSearchQuery(rawQuery);
        const start = parseInt(req.query.start, 10) || 1;
        const colorWord = /^(red|blue|green|orange|yellow|pink|purple|black|white|brown|gold|silver|grey|gray|navy|teal)$/i;
        const queryWords = searchQuery.split(/\s+/).filter(Boolean);
        const withoutColor = queryWords.filter((w) => !colorWord.test(w)).join(' ');
        console.log('[IMAGE SEARCH] query:', searchQuery, rawQuery !== searchQuery ? `(from: ${rawQuery})` : '', 'start:', start);

        let openverseError;
        try {
            const openverseImages = await fetchOpenverseImages(searchQuery, start);
            // Rank by subject terms. Blind first-hit was returning olives for
            // "Limoncello food" because Openverse's default order is not relevance.
            let ranked = rankImagesForSubject(openverseImages, searchQuery);
            if (ranked.length === 0 && withoutColor && withoutColor !== searchQuery) {
                const extra = await fetchOpenverseImages(withoutColor, start);
                ranked = rankImagesForSubject(extra, withoutColor);
            }
            if (ranked.length > 0) {
                // Proxy thumbs + full-size. Openverse's own /thumb/ 424s too often;
                // origin Flickr/Commons URLs are reliable through our proxy.
                warmupImageCache(ranked).catch(() => {});
                const images = wrapImagesForProxy(ranked, { proxyThumbnail: true });
                console.log('[IMAGE SEARCH] Using Openverse:', images.length, 'images (ranked)');
                return res.json({ images, source: 'openverse', start, nextStart: start + 10 });
            }
            if (openverseImages.length > 0) {
                console.log(
                    '[IMAGE SEARCH] Openverse had',
                    openverseImages.length,
                    'hits but none matched subject — trying Wikimedia'
                );
            } else {
                console.log('[IMAGE SEARCH] Openverse returned nothing — trying Wikimedia');
            }
        } catch (err) {
            openverseError = err.response?.data?.detail || err.message;
            console.warn('[IMAGE SEARCH] Openverse failed:', openverseError);
        }

        try {
            const words = searchQuery.split(/\s+/).filter(Boolean);
            const shortCandidates = [];
            if (withoutColor && withoutColor !== searchQuery) shortCandidates.push(withoutColor);
            if (words.length > 2) shortCandidates.push(words.slice(-2).join(' '));
            if (words.length > 3) shortCandidates.push(words.slice(-3).join(' '));

            const tryWiki = async (q) => {
                const rows = await fetchWikimediaCommonsImages(q, start);
                return rankImagesForSubject(rows, q);
            };

            let rankedWiki = await tryWiki(searchQuery);
            if (rankedWiki.length === 0) {
                for (const short of shortCandidates) {
                    if (!short || short === searchQuery) continue;
                    console.log('[IMAGE SEARCH] Wikimedia empty/unrelated — retry:', short);
                    rankedWiki = await tryWiki(short);
                    if (rankedWiki.length > 0) break;
                }
            }
            if (rankedWiki.length > 0) {
                warmupImageCache(rankedWiki).catch(() => {});
                const images = wrapImagesForProxy(rankedWiki);
                console.log('[IMAGE SEARCH] Using Wikimedia fallback:', images.length, 'images');
                return res.json({
                    images,
                    source: 'wikimedia',
                    start,
                    nextStart: start + 10
                });
            }
        } catch (wikiError) {
            console.warn('[IMAGE SEARCH] Wikimedia fallback failed:', wikiError.message);
        }

        return res.status(503).json({
            error: 'No images found',
            details: openverseError
                ? `Openverse unavailable (${openverseError}) and Wikimedia Commons had no match for "${searchQuery}".`
                : `Neither Openverse nor Wikimedia Commons had an openly-licensed match for "${searchQuery}".`,
            fix: 'Both sources only index openly-licensed media, so copyrighted subjects often have no results. Try a broader or more descriptive search term.'
        });
    } catch (error) {
        const details = error.response?.data?.error?.message || error.message;
        console.error('[IMAGE SEARCH] Error:', details);
        res.status(500).json({ error: 'Failed to fetch images', details });
    }
};

// Image search mounts peeled to backend/services/media-service (:4805)
// app.get('/api/image-search', imageSearchHandler);
// app.get('/api/google-image-search', imageSearchHandler);


// =====================================================
// PERSONAL INFO ENDPOINTS
// =====================================================

// Session configuration
const PERSISTENT_SESSION = {
    id: 'persistent-storage-001',
    version: 'v1',
    type: 'global',
    created: new Date().toISOString()
};

// Session validation helper
function isValidSessionId(sid) {
    const parts = sid.split('-');
    return (
        parts.length === 3 &&
        ['global', 'user', 'admin'].includes(parts[0]) &&
        /^v\d+$/.test(parts[2])
    );
}


// =====================================================
// RECIPE ENDPOINT — moved to backend/services/recipes-service (:4808)
// Gateway proxies /api/recipe there. See routes/recipe.routes.js stub.
// =====================================================

// =====================================================
// MONGO DB CONNECTION AND MODELS
// =====================================================

// Import models
const PersonalInfo = require('./models/PersonalInfo');
const Joke = require('./models/Joke');
const YouTubeSearch = require('./models/YouTubeSearch');

// Single MongoDB connection
let retryCount = 0;
const maxRetries = 3;
let isConnecting = false; // Prevent multiple simultaneous connection attempts

async function connectWithRetry() {
    // Prevent multiple simultaneous connection attempts
    if (isConnecting) {
        console.log('MongoDB connection already in progress, skipping...');
        return;
    }

    if (retryCount >= maxRetries) {
        console.error('MongoDB connection failed after maximum retries. Please check your connection and restart the server.');
        return;
    }

    isConnecting = true;

    try {
        const mongoUri = await resolveMongoUri(process.env.MONGODB_URI);
        await mongoose.connect(mongoUri, {
            serverSelectionTimeoutMS: 30000, // 30 seconds
            socketTimeoutMS: 45000, // 45 seconds
            maxPoolSize: 10,
            minPoolSize: 2,
            maxIdleTimeMS: 30000
        });
        console.log('\x1b[32m%s\x1b[0m', 'MongoDB connect with Retry on HOST and PORT successful:');
        console.log('\x1b[32m%s\x1b[0m', JSON.stringify({
            host: mongoose.connection.host || 'Atlas Cluster',
            port: mongoose.connection.port || 'SRV',
            name: mongoose.connection.name || mongoose.connection.db?.databaseName || 'Unknown'
        }, null, 4));
        retryCount = 0; // Reset retry count on successful connection
        isConnecting = false; // Reset connection flag
    } catch (err) {
        console.error('MongoDB connection error:', {
            error: err.message,
            attempt: retryCount + 1,
            maxRetries
        });

        if (retryCount < maxRetries) {
            retryCount++;
            console.log(`Retrying connection in 5 seconds... (Attempt ${retryCount}/${maxRetries})`);
            setTimeout(() => {
                isConnecting = false; // Reset flag before retrying
                connectWithRetry();
            }, 5000);
        } else {
            console.error('MongoDB connection failed after maximum retries — will keep trying every 30s.');
            retryCount = 0;
            setTimeout(() => {
                isConnecting = false;
                connectWithRetry();
            }, 30000);
        }
    }
}

// Initial connection
console.log('[MONGODB] Starting connection process...');
console.log('[MONGODB] Environment check:', {
    MONGODB_URI: process.env.MONGODB_URI ? 'Present' : 'Missing',
    NODE_ENV: process.env.NODE_ENV || 'development'
});

if (!process.env.MONGODB_URI) {
    console.error('[MONGODB] ERROR: MONGODB_URI environment variable is not set!');
    console.error('[MONGODB] Please check backend/server/.env (local) or Render Environment variables.');
    process.exit(1);
}

connectWithRetry();

// Set up conversation collection reference after connection
mongoose.connection.once('open', () => {
    conversationCollection = mongoose.connection.collection('conversation_history');
    console.log('[DEBUG - MONGO] Conversation collection reference set');
});

mongoose.connection.on('connected', () => {
    retryCount = 0;
    isConnecting = false;
    console.log('[MONGODB] Connection ready (readyState=1)');
});

// Handle disconnection — keep trying; don't permanently give up after maxRetries
mongoose.connection.on('disconnected', () => {
    console.log('MongoDB disconnected:', {
        status: 'disconnected',
        readyState: mongoose.connection.readyState,
        time: new Date().toISOString()
    });

    if (isConnecting) return;

    // Reset retry budget so transient Atlas blips can recover without a full restart
    if (retryCount >= maxRetries) {
        retryCount = 0;
    }
    console.log('Attempting to reconnect to MongoDB...');
    setTimeout(() => connectWithRetry(), 2000);
});


// =====================================================
// MONGO DB TEST ROUTES — peeled to platform-service (:4812)
// =====================================================
// app.get('/api/db-test', …);
// app.post('/api/cleanup', …);
// app.get('/api/debug/db-state', …);
// app.post('/api/debug/add-test-joke', …);


// YouTube persistence MOVED to media-service (:4805)
// =====================================================
// YOUTUBE SEARCH PERSISTENCE ENDPOINTS
// =====================================================
// 
// Save YouTube search query to database (explicit user Save — isSaved: true)
// app.post('/api/youtube/save-search', requireDataScope, async (req, res) => {
//     try {
//         let { query, displayName, totalPages, videoCount, cacheKeys, searchMetadata, videoResults } = req.body;
//         const userId = req.scopeKey;
// 
//         // Normalize query for internal storage; always strip voice/UI prefixes from displayName
//         const stripYouTubePrefix = (q) =>
//             String(q || '')
//                 .replace(/^(?:youtube\s+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)\s+/i, '')
//                 .trim();
//         const normalizeQuery = (q) => {
//             return stripYouTubePrefix(q)
//                 .normalize('NFD')
//                 .replace(/\p{M}/gu, '')
//                 .toLowerCase()
//                 .trim()
//                 .replace(/\s+/g, '.') // Replace spaces with dots
//                 .replace(/[^a-z0-9.]/g, '') // Remove special characters except dots
//                 .replace(/\.+/g, '.') // Replace multiple dots with single dot
//                 .replace(/^\.+|\.+$/g, ''); // Remove leading/trailing dots
//         };
// 
//         const originalQuery = (query || '').trim();
//         query = normalizeQuery(originalQuery);
// 
//         // Prefer cleaned subject over raw "Youtube Seach …" display names;
//         // never keep a vowel-stripped label ("Sigur Rs") when a fuller one exists.
//         displayName = preferYouTubeDisplayNameServer(
//             stripYouTubePrefix(displayName || originalQuery),
//             stripYouTubePrefix(originalQuery),
//             query.replace(/\./g, ' ').replace(/\b\w/g, l => l.toUpperCase())
//         );
// 
//         console.log('💾 [YOUTUBE-DB] Explicit SAVE search:', { query, userId, displayName });
// 
//         // Prefer fullest existing cache (handles legacy query keys). Every lookup
//         // is confined to this account: matching on the query alone would reuse —
//         // and then overwrite — another user's saved search.
//         let existingSearch =
//             (await findBestYouTubeSearchCache(originalQuery, userId)) ||
//             (await YouTubeSearch.findOne({ userId, query }));
// 
//         if (existingSearch) {
//             existingSearch.lastSearched = new Date();
//             existingSearch.isSaved = true;
//             existingSearch.userId = userId;
//             existingSearch.query = query || existingSearch.query;
//             existingSearch.displayName = preferYouTubeDisplayNameServer(
//                 displayName,
//                 existingSearch.displayName
//             );
//             existingSearch.cacheKeys = cacheKeys || existingSearch.cacheKeys;
//             existingSearch.searchMetadata = { ...existingSearch.searchMetadata, ...searchMetadata };
//             if (Array.isArray(videoResults) && videoResults.length) {
//                 existingSearch.videoResults = mergeYouTubeVideoResults(
//                     existingSearch.videoResults,
//                     videoResults
//                 );
//             }
//             existingSearch.totalPages = Math.max(
//                 Number(totalPages) || 0,
//                 existingSearch.videoResults?.length || 0,
//                 Number(existingSearch.totalPages) || 0
//             );
//             existingSearch.videoCount =
//                 (existingSearch.videoResults || []).reduce(
//                     (n, p) => n + (p.videos?.length || 0),
//                     0
//                 ) || videoCount || existingSearch.videoCount;
//             await existingSearch.save();
// 
//             console.log('💾 [YOUTUBE-DB] Marked existing search as saved:', existingSearch._id, 'pages:', existingSearch.videoResults?.length);
//             res.json({ success: true, message: 'Search saved', search: existingSearch });
//         } else {
//             const newSearch = new YouTubeSearch({
//                 query,
//                 userId,
//                 displayName: displayName || query,
//                 totalPages: totalPages || (videoResults?.length || 1),
//                 videoCount: videoCount || 0,
//                 cacheKeys: cacheKeys || [],
//                 searchMetadata: searchMetadata || {},
//                 videoResults: Array.isArray(videoResults) ? videoResults : [],
//                 isSaved: true,
//                 dateCreated: new Date(),
//                 lastSearched: new Date()
//             });
// 
//             await newSearch.save();
// 
//             console.log('💾 [YOUTUBE-DB] Saved new search:', newSearch._id);
//             res.json({ success: true, message: 'Search saved', search: newSearch });
//         }
//     } catch (error) {
//         console.error('💾 [YOUTUBE-DB] Error saving search:', error);
//         res.status(500).json({ success: false, error: error.message });
//     }
// });
// 
// Get YouTube searches (History). Include isSaved so UI can show green LED.
// app.get('/api/youtube/saved-searches', requireDataScope, async (req, res) => {
//     try {
//         const { savedOnly } = req.query;
//         const userId = req.scopeKey;
// 
//         console.log('📚 [YOUTUBE-DB] Retrieving searches for user:', userId, 'savedOnly:', savedOnly);
// 
//         // Owner comes from the token. A ?userId= parameter used to select the
//         // bucket, and omitting it returned every account's history.
//         const userIds =
//             userId === LEGACY_DATA_KEY ? LEGACY_USER_ALIASES : [userId];
// 
//         const filter = {
//             userId: { $in: userIds },
//             ...(savedOnly === 'true' || savedOnly === '1'
//                 ? { isSaved: { $ne: false } }
//                 : {}),
//         };
// 
//         const savedSearches = await YouTubeSearch.find(filter)
//             .sort({ lastSearched: -1 });
// 
//         console.log('📚 [YOUTUBE-DB] Found', savedSearches.length, 'searches');
// 
//         res.json({
//             success: true,
//             searches: savedSearches.map(search => {
//                 const cachedPages = Array.isArray(search.videoResults)
//                     ? search.videoResults.length
//                     : 0;
//                 const storedPages = Number(search.totalPages) || 0;
//                 return {
//                     _id: search._id,
//                     query: search.query,
//                     displayName: (() => {
//                         const hints = (Array.isArray(search.videoResults) ? search.videoResults : [])
//                             .flatMap((p) => (p.videos || []).slice(0, 4).map((v) => v.title || ''))
//                             .filter(Boolean)
//                             .slice(0, 16);
//                         // Repair legacy labels before the client renders History
//                         let name = String(search.displayName || search.query || '')
//                             .replace(/^[@＠]+/gu, '')
//                             .replace(/[:;,.!?…]+$/gu, '')
//                             .replace(/^(?:youtube\s+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)\s+/i, '')
//                             .trim();
//                         const skel = youtubeConsonantSkeletonServer(name);
//                         for (const title of hints) {
//                             const head = String(title || '')
//                                 .replace(/^@+/g, '')
//                                 .split(/\s+[-\u2013|:]+|\s+[(\[]/)[0]
//                                 ?.trim();
//                             if (!head) continue;
//                             if (skel && youtubeConsonantSkeletonServer(head) === skel) {
//                                 const words = name.split(/\s+/).length || 1;
//                                 const repaired = head.split(/\s+/).slice(0, words).join(' ');
//                                 name = preferYouTubeDisplayNameServer(name, repaired);
//                                 break;
//                             }
//                         }
//                         if (name && name === name.toLowerCase()) {
//                             name = name.replace(/\b[a-z]/g, (c) => c.toUpperCase());
//                         }
//                         return name || search.displayName;
//                     })(),
//                     totalPages: Math.max(cachedPages, storedPages) || search.totalPages || 1,
//                     videoCount: search.videoCount,
//                     lastSearched: search.lastSearched,
//                     dateCreated: search.dateCreated,
//                     searchMetadata: search.searchMetadata,
//                     isSaved: search.isSaved !== false,
//                     hasCachedPages: cachedPages > 0,
//                     // Lightweight titles so the client can repair "Sigur Rs" → "Sigur Rós"
//                     titleHints: (Array.isArray(search.videoResults) ? search.videoResults : [])
//                         .flatMap((p) => (p.videos || []).slice(0, 4).map((v) => v.title || ''))
//                         .filter(Boolean)
//                         .slice(0, 16),
//                 };
//             })
//         });
//     } catch (error) {
//         console.error('📚 [YOUTUBE-DB] Error retrieving searches:', error);
//         res.status(500).json({ success: false, error: error.message });
//     }
// });
// 
// Remove cached videos whose thumbnails are unreachable (private/deleted)
// app.post('/api/youtube/cleanup-inaccessible', async (req, res) => {
//     try {
//         const https = require('https');
//         const http = require('http');
//         const q = String(req.body?.query || req.query?.query || '').trim();
// 
//         const headOk = (url) =>
//             new Promise((resolve) => {
//                 if (!url || typeof url !== 'string') return resolve(false);
//                 const lib = url.startsWith('https') ? https : http;
//                 const request = lib.request(url, { method: 'HEAD', timeout: 8000 }, (r) => {
//                     if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
//                         headOk(r.headers.location).then(resolve);
//                         return;
//                     }
//                     resolve(r.statusCode >= 200 && r.statusCode < 400);
//                 });
//                 request.on('error', () => resolve(false));
//                 request.on('timeout', () => {
//                     request.destroy();
//                     resolve(false);
//                 });
//                 request.end();
//             });
// 
//         const thumbReachable = async (video) => {
//             const id = video?.id;
//             const urls = [
//                 video?.thumbnail,
//                 id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null,
//                 id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null,
//             ].filter(Boolean);
//             for (const u of urls) {
//                 if (await headOk(u)) return true;
//             }
//             return false;
//         };
// 
//         const filter = q
//             ? {
//                 $or: [
//                     { query: new RegExp(q.replace(/\s+/g, '.*'), 'i') },
//                     { displayName: new RegExp(q.replace(/\s+/g, '\\s*'), 'i') },
//                 ],
//             }
//             : {};
// 
//         console.log('🧹 [YOUTUBE-DB] Cleanup inaccessible thumbs', q || '(all)');
//         const docs = await YouTubeSearch.find(filter);
//         let removedTotal = 0;
//         let updatedDocs = 0;
// 
//         for (const doc of docs) {
//             let changed = false;
//             const pages = Array.isArray(doc.videoResults) ? doc.videoResults : [];
//             for (const page of pages) {
//                 const before = (page.videos || []).length;
//                 const kept = [];
//                 for (const v of page.videos || []) {
//                     if (await thumbReachable(v)) kept.push(v);
//                     else {
//                         removedTotal++;
//                         console.log(
//                             '  drop',
//                             doc.query,
//                             `p${page.page}`,
//                             v.id,
//                             String(v.title || '').slice(0, 40)
//                         );
//                     }
//                 }
//                 if (kept.length !== before) {
//                     page.videos = kept;
//                     page.totalResults = kept.length;
//                     changed = true;
//                 }
//             }
//             if (changed) {
//                 updatedDocs++;
//                 doc.videoCount = pages.reduce((n, p) => n + (p.videos || []).length, 0);
//                 doc.totalPages = pages.length;
//                 doc.markModified('videoResults');
//                 await doc.save();
//             }
//         }
// 
//         res.json({
//             success: true,
//             matched: docs.length,
//             updatedDocs,
//             removedTotal,
//         });
//     } catch (error) {
//         console.error('🧹 [YOUTUBE-DB] Cleanup failed:', error);
//         res.status(500).json({ success: false, error: error.message });
//     }
// });
// 
// Delete OR un-save a YouTube search
// app.delete('/api/youtube/saved-searches/:searchId', requireDataScope, async (req, res) => {
//     try {
//         const { searchId } = req.params;
//         const { unsaveOnly } = req.query;
//         const userId = req.scopeKey;
// 
//         console.log('🗑️ [YOUTUBE-DB] Delete/unsave search:', searchId, 'for user:', userId, 'unsaveOnly:', unsaveOnly);
// 
//         // Scoped lookup: an id alone would let any caller delete any account's search
//         const owners = userId === LEGACY_DATA_KEY ? LEGACY_USER_ALIASES : [userId];
//         const doc = await YouTubeSearch.findOne({ _id: searchId, userId: { $in: owners } });
//         if (!doc) {
//             return res.status(404).json({ success: false, error: 'Search not found' });
//         }
// 
//         // Unsave only when explicitly requested — keep videoResults for quota cache
//         if (unsaveOnly === 'true' || unsaveOnly === '1') {
//             doc.isSaved = false;
//             await doc.save();
//             console.log('🗑️ [YOUTUBE-DB] Unsaved (kept cache pages):', doc.query);
//             return res.json({ success: true, message: 'Search unsaved', unsaved: true, search: doc });
//         }
// 
//         // Hard delete — gone from MongoDB (listing + cached pages)
//         await YouTubeSearch.deleteOne({ _id: doc._id });
//         console.log('🗑️ [YOUTUBE-DB] Deleted search:', doc.query);
//         res.json({ success: true, message: 'Search deleted', deleted: true });
//     } catch (error) {
//         console.error('🗑️ [YOUTUBE-DB] Error deleting search:', error);
//         res.status(500).json({ success: false, error: error.message });
//     }
// });
// 
// Check if a query is saved in database
// app.post('/api/youtube/check-saved', requireDataScope, async (req, res) => {
//     try {
//         let { queries } = req.body;
//         const userId = req.scopeKey;
//         queries = (queries || []).map(q => (q || '').trim().toLowerCase());
//         console.log('🔍 [YOUTUBE-DB] Checking saved status for', queries.length, 'queries for user:', userId);
// 
//         // Use the Mongoose model to find saved queries for this user
//         const savedQueries = await YouTubeSearch.find({
//             userId,
//             query: { $in: queries }
//         }).select('query');
// 
//         const savedQuerySet = new Set(savedQueries.map(s => s.query));
//         const results = {};
//         queries.forEach(query => {
//             results[query] = savedQuerySet.has(query);
//         });
//         res.json({ success: true, results });
//     } catch (error) {
//         console.error('🔍 [YOUTUBE-DB] Error checking saved status:', error);
//         res.status(500).json({ success: false, error: error.message });
//     }
// });
// 
// 
// YouTube helpers + /api/youtube/* MOVED to media-service (:4805)
// =====================================================
// YOUTUBE API ENDPOINTS
// =====================================================
// 
// YouTube API Cache and Optimization System
// const youtubeCache = new NodeCache({
//     stdTTL: 3600, // 1 hour cache
//     checkperiod: 600, // Check for expired keys every 10 minutes
//     maxKeys: 1000 // Limit cache size
// });
// 
// Quota tracking with persistence
// const quotaFilePath = path.join(__dirname, 'quota-tracking.json');
// 
// let dailyQuotaUsed = 0;
// let googleQuotaExceeded = false;
// let googleQuotaExceededAt = null;
// let quotaResetTime = new Date();
// 
// Simple approach: Reset at midnight Pacific Time (7 AM UTC)
// quotaResetTime.setUTCHours(7, 0, 0, 0);
// if (quotaResetTime <= new Date()) {
//     quotaResetTime.setDate(quotaResetTime.getDate() + 1);
// }
// 
// Load persistent quota data on startup
// function loadQuotaData() {
//     try {
//         if (fs.existsSync(quotaFilePath)) {
//             const data = JSON.parse(fs.readFileSync(quotaFilePath, 'utf8'));
//             const savedResetTime = new Date(data.resetTime);
// 
//             // If the saved reset time hasn't passed yet, restore the usage
//             if (savedResetTime > new Date()) {
//                 dailyQuotaUsed = data.used || 0;
//                 googleQuotaExceeded = !!data.googleQuotaExceeded;
//                 googleQuotaExceededAt = data.googleQuotaExceededAt || null;
//                 quotaResetTime = savedResetTime;
//                 console.log(`📊 [QUOTA] Restored from file: ${dailyQuotaUsed}/10000 used, googleExceeded=${googleQuotaExceeded}, resets at ${quotaResetTime.toISOString()}`);
//             } else {
//                 console.log(`📊 [QUOTA] Quota file found but expired, starting fresh`);
//                 saveQuotaData(); // Save current state
//             }
//         } else {
//             console.log(`📊 [QUOTA] No quota file found, starting fresh`);
//             saveQuotaData(); // Create initial file
//         }
//     } catch (error) {
//         console.error('📊 [QUOTA] Error loading quota data:', error);
//         saveQuotaData(); // Create fresh file on error
//     }
// }
// 
// Save quota data to file
// function saveQuotaData() {
//     try {
//         const data = {
//             used: dailyQuotaUsed,
//             googleQuotaExceeded,
//             googleQuotaExceededAt,
//             resetTime: quotaResetTime.toISOString(),
//             lastUpdated: new Date().toISOString()
//         };
//         fs.writeFileSync(quotaFilePath, JSON.stringify(data, null, 2));
//     } catch (error) {
//         console.error('📊 [QUOTA] Error saving quota data:', error);
//     }
// }
// 
// Load quota data on startup
// loadQuotaData();
// 
// Request deduplication - prevent multiple identical requests
// const pendingRequests = new Map();
// 
// function resetQuotaIfNeeded() {
//     const now = new Date();
//     if (now >= quotaResetTime) {
//         const oldUsage = dailyQuotaUsed;
//         dailyQuotaUsed = 0;
//         googleQuotaExceeded = false;
//         googleQuotaExceededAt = null;
//         quotaResetTime.setDate(quotaResetTime.getDate() + 1);
//         quotaResetTime.setUTCHours(7, 0, 0, 0); // Ensure it's set to 7 AM UTC
//         console.log(`📊 [QUOTA] Daily quota reset: ${oldUsage} → 0. Next reset: ${quotaResetTime.toISOString()}`);
//         saveQuotaData(); // Persist the reset
//     }
// }
// 
// function isYouTubeQuotaError(error) {
//     const message = (error?.message || String(error)).toLowerCase();
//     return (
//         message.includes('quota') &&
//         (message.includes('exceeded') ||
//             message.includes('limit') ||
//             message.includes('daily'))
//     );
// }
// 
// function markGoogleQuotaExceeded(source = 'api') {
//     if (!googleQuotaExceeded) {
//         googleQuotaExceeded = true;
//         googleQuotaExceededAt = new Date().toISOString();
//         console.log(`🚫 [QUOTA] Google daily quota EXCEEDED (source: ${source})`);
//         saveQuotaData();
//     }
// }
// 
// function getEffectiveQuotaUsed() {
//     resetQuotaIfNeeded();
//     return googleQuotaExceeded ? 10000 : dailyQuotaUsed;
// }
// 
// function getQuotaStatus() {
//     resetQuotaIfNeeded();
//     const used = getEffectiveQuotaUsed();
//     const total = 10000;
//     return {
//         used,
//         trackedUsed: dailyQuotaUsed,
//         remaining: Math.max(0, total - used),
//         total,
//         percentage: Math.round((used / total) * 100),
//         resetTime: quotaResetTime.toISOString(),
//         timeUntilReset: Math.round((quotaResetTime - new Date()) / 1000 / 60),
//         googleQuotaExceeded,
//         googleQuotaExceededAt,
//         status: googleQuotaExceeded ? 'exceeded' : used >= total ? 'exceeded' : 'ok',
//         cacheStats: {
//             keys: youtubeCache.keys().length,
//             hits: youtubeCache.getStats().hits || 0,
//             misses: youtubeCache.getStats().misses || 0
//         }
//     };
// }
// 
// function trackQuotaUsage(cost, operation = 'unknown') {
//     resetQuotaIfNeeded();
//     dailyQuotaUsed += cost;
//     const percentage = Math.round((dailyQuotaUsed / 10000) * 100);
//     console.log(`💰 [QUOTA-TRACK] +${cost} for ${operation} | Total: ${dailyQuotaUsed}/10000 (${percentage}%)`);
//     saveQuotaData(); // Persist the updated quota
// }
// 
// function getRemainingQuota() {
//     resetQuotaIfNeeded();
//     if (googleQuotaExceeded) return 0;
//     return 10000 - dailyQuotaUsed;
// }
// 
// /** Omit null/empty pageToken — passing pageToken= causes YouTube API fetch failures */
// function buildYouTubeSearchParams(params) {
//     const clean = { ...params };
//     if (!clean.pageToken) {
//         delete clean.pageToken;
//     }
//     return clean;
// }
// 
// function youtubeSearchList(params, retries = 3) {
//     const attempt = async (remaining) => {
//         try {
//             return await youtube.search.list(buildYouTubeSearchParams(params));
//         } catch (error) {
//             const message = error?.message || String(error);
//             const retryable =
//                 remaining > 1 &&
//                 (/premature close/i.test(message) ||
//                     /ECONNRESET/i.test(message) ||
//                     /socket hang up/i.test(message) ||
//                     /ETIMEDOUT/i.test(message));
// 
//             if (retryable) {
//                 console.warn(
//                     `⚠️ [YOUTUBE-API] Retryable error (${remaining - 1} left):`,
//                     message.slice(0, 120)
//                 );
//                 await new Promise((resolve) => setTimeout(resolve, 600));
//                 return attempt(remaining - 1);
//             }
// 
//             if (isYouTubeQuotaError(error)) {
//                 markGoogleQuotaExceeded('youtube.search.list');
//             }
// 
//             throw error;
//         }
//     };
// 
//     return attempt(retries);
// }
// 
// function sanitizeYouTubeError(error) {
//     const message = error?.message || String(error);
//     return message.replace(/key=[^&\s]+/gi, 'key=[REDACTED]');
// }
// 
// function pickYouTubeThumbnail(snippet, videoId) {
//     const thumbs = snippet?.thumbnails || {};
//     return (
//         thumbs.maxres?.url ||
//         thumbs.standard?.url ||
//         thumbs.high?.url ||
//         thumbs.medium?.url ||
//         thumbs.default?.url ||
//         (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '')
//     );
// }
// 
// /** Drop private / inaccessible / thumbnail-less cards (incl. legacy Mongo cache). */
// function filterAccessibleYouTubeVideos(videos = []) {
//     return (videos || []).filter((v) => {
//         if (!v?.id) return false;
//         if (v.privacyStatus === 'private') return false;
//         if (v.uploadStatus && v.uploadStatus !== 'processed' && v.uploadStatus !== 'uploaded') {
//             return false;
//         }
//         // Legacy stubs often have empty duration AND empty/broken thumbs for private IDs
//         const thumb = String(v.thumbnail || '').trim();
//         if (!thumb) return false;
//         return true;
//     });
// }
// 
// /**
//  * Map search + videos.list details into UI cards.
//  * Drop private / missing-details videos (search can still list IDs that
//  * videos.list omits — those show as broken thumbnails if kept).
//  */
// function mapYouTubeVideosFromSearch(searchItems, videoDetailsItems) {
//     const detailsById = new Map(
//         (videoDetailsItems || []).map((video) => [video.id, video])
//     );
// 
//     return (searchItems || [])
//         .map((item) => {
//             const videoId = item?.id?.videoId;
//             if (!videoId) return null;
// 
//             const video = detailsById.get(videoId);
//             // Not returned by videos.list → private, deleted, or inaccessible
//             if (!video) return null;
// 
//             const privacy = video.status?.privacyStatus;
//             if (privacy === 'private') return null;
//             // uploadStatus "rejected" / "deleted" / "failed" are not playable
//             const upload = video.status?.uploadStatus;
//             if (upload && upload !== 'processed' && upload !== 'uploaded') return null;
// 
//             const thumbnail = pickYouTubeThumbnail(video.snippet, videoId);
//             if (!thumbnail) return null;
// 
//             return {
//                 id: video.id,
//                 title: video.snippet?.title || item.snippet?.title || 'Unknown Title',
//                 description: video.snippet?.description || '',
//                 channelTitle: video.snippet?.channelTitle || item.snippet?.channelTitle || '',
//                 channelId: video.snippet?.channelId || item.snippet?.channelId || '',
//                 publishedAt: video.snippet?.publishedAt || '',
//                 duration: video.contentDetails?.duration || '',
//                 thumbnail,
//                 privacyStatus: privacy || 'public',
//                 uploadStatus: upload || 'processed',
//             };
//         })
//         .filter(Boolean);
// }
// 
// function extractVideoIds(searchItems) {
//     return (searchItems || [])
//         .map((item) => item?.id?.videoId)
//         .filter(Boolean);
// }
// 
// function generateCacheKey(query, type, page, pageToken) {
//     return `yt_${type}_${query.toLowerCase().replace(/\s+/g, '_')}_p${page}_${pageToken || 'none'}`;
// }
// 
// Save YouTube search results to MongoDB for future cache restoration
// PageToken management functions
// async function savePageToken(query, searchType, page, pageToken, nextPageToken = null) {
//     try {
//         await PageToken.findOneAndUpdate(
//             { query, searchType, page },
//             {
//                 pageToken,
//                 nextPageToken,
//                 lastAccessed: new Date()
//             },
//             { upsert: true, new: true }
//         );
//         console.log(`🔑 [PAGETOKEN] Saved pageToken for ${searchType} "${query}" page ${page}`);
//     } catch (error) {
//         console.error(`🔑 [PAGETOKEN] Failed to save pageToken:`, error);
//     }
// }
// 
// async function getPageToken(query, searchType, page) {
//     try {
//         const tokenDoc = await PageToken.findOne({ query, searchType, page });
//         if (tokenDoc) {
//             // Update last accessed time
//             tokenDoc.lastAccessed = new Date();
//             await tokenDoc.save();
//             console.log(`🔑 [PAGETOKEN] Retrieved pageToken for ${searchType} "${query}" page ${page}`);
//             return tokenDoc.pageToken;
//         }
//         return null;
//     } catch (error) {
//         console.error(`🔑 [PAGETOKEN] Failed to retrieve pageToken:`, error);
//         return null;
//     }
// }
// 
// async function getNextPageToken(query, searchType, page) {
//     try {
//         const tokenDoc = await PageToken.findOne({ query, searchType, page });
//         if (tokenDoc && tokenDoc.nextPageToken) {
//             console.log(`🔑 [PAGETOKEN] Retrieved nextPageToken for ${searchType} "${query}" page ${page}`);
//             return tokenDoc.nextPageToken;
//         }
//         return null;
//     } catch (error) {
//         console.error(`🔑 [PAGETOKEN] Failed to retrieve nextPageToken:`, error);
//         return null;
//     }
// }
// 
// /** Normalize YouTube query the same way the React client does. */
// function foldYouTubeAsciiServer(text) {
//     return String(text || '')
//         .normalize('NFD')
//         .replace(/\p{M}/gu, '');
// }
// 
// function youtubeConsonantSkeletonServer(q) {
//     return foldYouTubeAsciiServer(q)
//         .toLowerCase()
//         .replace(/[^a-z0-9\s.]/g, '')
//         .replace(/[aeiou]/g, '')
//         .replace(/[.\s]+/g, ' ')
//         .trim();
// }
// 
// /** Accent twin only — not a longer distinct query (Privettriker ≠ PrivettrickerRevival). */
// function youtubeQueriesLooselyEqualServer(a, b) {
//     const na = normalizeYouTubeQueryKey(a);
//     const nb = normalizeYouTubeQueryKey(b);
//     if (!na || !nb) return false;
//     if (na === nb) return true;
//     if (na.replace(/\./g, '') === nb.replace(/\./g, '')) return true;
//     const sa = youtubeConsonantSkeletonServer(na);
//     const sb = youtubeConsonantSkeletonServer(nb);
//     if (!sa || sa !== sb) return false;
//     return Math.abs(na.replace(/\./g, '').length - nb.replace(/\./g, '').length) <= 2;
// }
// 
// function normalizeYouTubeQueryKey(q) {
//     return foldYouTubeAsciiServer(
//         String(q || '')
//             .replace(/^(?:youtube\s+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)\s+/i, '')
//             .trim()
//     )
//         .toLowerCase()
//         .trim()
//         .replace(/\s+/g, '.')
//         .replace(/[^a-z0-9.]/g, '')
//         .replace(/\.+/g, '.')
//         .replace(/^\.+|\.+$/g, '');
// }
// 
// function preferYouTubeDisplayNameServer(...candidates) {
//     let best = '';
//     const vowelCount = (t) => (foldYouTubeAsciiServer(t).match(/[aeiou]/gi) || []).length;
//     for (const raw of candidates) {
//         const cleaned = String(raw || '')
//             .replace(/^(?:youtube\s+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)\s+/i, '')
//             .trim();
//         if (!cleaned) continue;
//         if (!best) {
//             best = cleaned;
//             continue;
//         }
//         const bestUni = /[^\u0000-\u007F]/.test(best);
//         const nextUni = /[^\u0000-\u007F]/.test(cleaned);
//         if (nextUni && !bestUni) {
//             best = cleaned;
//             continue;
//         }
//         if (bestUni && !nextUni) continue;
//         const skelBest = youtubeConsonantSkeletonServer(best);
//         const skelNext = youtubeConsonantSkeletonServer(cleaned);
//         if (skelBest && skelBest === skelNext) {
//             if (vowelCount(cleaned) > vowelCount(best)) best = cleaned;
//             else if (vowelCount(cleaned) === vowelCount(best) && cleaned.length > best.length) best = cleaned;
//             continue;
//         }
//         if (cleaned.length > best.length) best = cleaned;
//     }
//     return best;
// }
// 
// function escapeRegexLiteral(s) {
//     return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// }
// 
// /**
//  * Find the best cached YouTubeSearch doc for a query.
//  * Prefer the document with the most videoResults pages so we never
//  * miss an older full Santana cache when a newer 1-page stub exists.
//  */
// /**
//  * Find a youtube_searches row for this query even when videoResults is empty
//  * (bookmark / history shell with no cached pages).
//  */
// async function findYouTubeSearchMeta(query, ownerId = null) {
//     const normalized = normalizeYouTubeQueryKey(query);
//     const variants = [...new Set([
//         query,
//         String(query || '').trim(),
//         String(query || '').trim().toLowerCase(),
//         normalized,
//         normalized.replace(/\./g, ' '),
//     ].filter(Boolean))];
// 
//     const ownerFilter = ownerId ? { userId: ownerId } : {};
// 
//     for (const variant of variants) {
//         const match = await YouTubeSearch.findOne({
//             ...ownerFilter,
//             $or: [
//                 { query: { $regex: new RegExp(`^${escapeRegexLiteral(variant)}$`, 'i') } },
//                 { displayName: { $regex: new RegExp(`^${escapeRegexLiteral(variant)}$`, 'i') } },
//             ],
//         }).sort({ lastSearched: -1 });
//         if (match) return match;
//     }
// 
//     if (normalized) {
//         const candidates = await YouTubeSearch.find(ownerFilter)
//             .sort({ lastSearched: -1 })
//             .limit(800);
//         for (const doc of candidates) {
//             if (normalizeYouTubeQueryKey(doc.query) === normalized) return doc;
//             if (normalizeYouTubeQueryKey(doc.displayName) === normalized) return doc;
//             if (
//                 youtubeQueriesLooselyEqualServer(normalized, doc.query) ||
//                 youtubeQueriesLooselyEqualServer(normalized, doc.displayName)
//             ) {
//                 return doc;
//             }
//         }
//     }
//     return null;
// }
// 
// /**
//  * Best cached document for a query.
//  *
//  * Pass ownerId when the caller intends to modify the result. Without it the
//  * search spans every account, which is fine for serving cached video pages
//  * (it saves API quota and the caller already supplied the query) but would
//  * otherwise let one user adopt and rewrite another user's saved search.
//  */
// async function findBestYouTubeSearchCache(query, ownerId = null) {
//     const normalized = normalizeYouTubeQueryKey(query);
//     const variants = [...new Set([
//         query,
//         String(query || '').trim(),
//         String(query || '').trim().toLowerCase(),
//         normalized,
//         normalized.replace(/\./g, ' '),
//     ].filter(Boolean))];
// 
//     const ownerFilter = ownerId ? { userId: ownerId } : {};
//     const scored = [];
// 
//     for (const variant of variants) {
//         const matches = await YouTubeSearch.find({
//             ...ownerFilter,
//             $or: [
//                 { query: { $regex: new RegExp(`^${escapeRegexLiteral(variant)}$`, 'i') } },
//                 { displayName: { $regex: new RegExp(`^${escapeRegexLiteral(variant)}$`, 'i') } },
//             ],
//             'videoResults.0': { $exists: true },
//         }).limit(20);
//         for (const doc of matches) {
//             if (doc?.videoResults?.length) scored.push(doc);
//         }
//     }
// 
//     // Normalized-key scan across recent docs (covers legacy un-normalized query fields)
//     if (normalized) {
//         const candidates = await YouTubeSearch.find({
//             ...ownerFilter,
//             'videoResults.0': { $exists: true },
//         })
//             .sort({ lastSearched: -1 })
//             .limit(800);
//         for (const doc of candidates) {
//             if (normalizeYouTubeQueryKey(doc.query) === normalized) scored.push(doc);
//             else if (normalizeYouTubeQueryKey(doc.displayName) === normalized) scored.push(doc);
//             else if (
//                 youtubeQueriesLooselyEqualServer(normalized, doc.query) ||
//                 youtubeQueriesLooselyEqualServer(normalized, doc.displayName)
//             ) {
//                 // Accent twins only (sigur.rs ↔ sigur.ros) — not longer distinct names
//                 scored.push(doc);
//             }
//         }
//     }
// 
//     if (!scored.length) return null;
// 
//     const byId = new Map();
//     for (const doc of scored) {
//         const id = String(doc._id);
//         const prev = byId.get(id);
//         if (!prev || (doc.videoResults?.length || 0) > (prev.videoResults?.length || 0)) {
//             byId.set(id, doc);
//         }
//     }
// 
//     return [...byId.values()].sort(
//         (a, b) => (b.videoResults?.length || 0) - (a.videoResults?.length || 0)
//     )[0];
// }
// 
// /** Merge page arrays by page number — never drop already-cached pages. */
// function mergeYouTubeVideoResults(existing = [], incoming = []) {
//     const byPage = new Map();
//     for (const p of existing || []) {
//         if (p && p.page != null) byPage.set(Number(p.page), p);
//     }
//     for (const p of incoming || []) {
//         if (p && p.page != null) byPage.set(Number(p.page), p);
//     }
//     return [...byPage.values()].sort((a, b) => Number(a.page) - Number(b.page));
// }
// 
// async function saveSearchResultToMongoDB(query, page, videos, resultType, nextPageToken = null, quotaUsed = 101) {
//     try {
//         // Create the video result data
//         const videoResultData = {
//             page,
//             videos,
//             resultType,
//             nextPageToken,
//             totalResults: videos.length,
//             apiQuotaUsed: quotaUsed,
//             timestamp: new Date()
//         };
// 
//         const normalizedQuery = normalizeYouTubeQueryKey(query);
// 
//         // Prefer fullest existing cache (legacy keys + normalized), then update in place
//         let searchDoc = await findBestYouTubeSearchCache(query);
//         if (
//             searchDoc &&
//             !youtubeQueriesLooselyEqualServer(query, searchDoc.query) &&
//             !youtubeQueriesLooselyEqualServer(query, searchDoc.displayName)
//         ) {
//             // Never merge into a different channel/search just because findBest scored it highest
//             searchDoc = null;
//         }
//         if (!searchDoc) {
//             searchDoc = await YouTubeSearch.findOne({ query: normalizedQuery });
//         }
// 
//         if (!searchDoc) {
//             const humanReadableDisplay = normalizedQuery.replace(/\./g, ' ').replace(/\b\w/g, l => l.toUpperCase());
//             const niceDisplay = preferYouTubeDisplayNameServer(
//                 String(query || '').replace(/^(?:youtube\s+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)\s+/i, '').trim(),
//                 humanReadableDisplay
//             );
// 
//             // Create new search document — cache pages only, NOT user-saved bookmark
//             searchDoc = new YouTubeSearch({
//                 query: normalizedQuery, // Store normalized query
//                 userId: 'default-user',
//                 displayName: niceDisplay, // Human-readable display name
//                 videoCount: videos.length,
//                 lastSearched: new Date(),
//                 dateCreated: new Date(),
//                 videoResults: [videoResultData],
//                 isSaved: false
//             });
//             await searchDoc.save();
//         } else {
//             // Keep canonical normalized key so future lookups hit this doc
//             const incomingKey = normalizedQuery || searchDoc.query;
//             const skelIncoming = youtubeConsonantSkeletonServer(incomingKey);
//             const skelExisting = youtubeConsonantSkeletonServer(searchDoc.query);
//             // Prefer vowel-complete key (sigur.ros over legacy sigur.rs) only for true twins
//             if (
//                 youtubeQueriesLooselyEqualServer(incomingKey, searchDoc.query) &&
//                 skelIncoming &&
//                 skelIncoming === skelExisting &&
//                 (incomingKey.match(/[aeiou]/gi) || []).length >
//                     (String(searchDoc.query || '').match(/[aeiou]/gi) || []).length
//             ) {
//                 searchDoc.query = incomingKey;
//             } else if (normalizeYouTubeQueryKey(searchDoc.query) === incomingKey) {
//                 searchDoc.query = incomingKey || searchDoc.query;
//             }
//             // Do not rename a different search's query field to the incoming key
//             searchDoc.displayName = preferYouTubeDisplayNameServer(
//                 searchDoc.displayName,
//                 String(query || '').replace(/^(?:youtube\s+(?:search|seach|play|channel|movies?|tv)|youtube|search|channel|movies?|tv)\s+/i, '').trim(),
//                 String(searchDoc.query || '').replace(/\./g, ' ').replace(/\b\w/g, l => l.toUpperCase())
//             );
//             if (!Array.isArray(searchDoc.videoResults)) searchDoc.videoResults = [];
//             const existingPageIndex = searchDoc.videoResults.findIndex(result => Number(result.page) === Number(page));
// 
//             if (existingPageIndex >= 0) {
//                 searchDoc.videoResults[existingPageIndex] = videoResultData;
//             } else {
//                 searchDoc.videoResults.push(videoResultData);
//             }
// 
//             searchDoc.lastSearched = new Date();
//             searchDoc.videoCount = searchDoc.videoResults.reduce((total, result) => total + (result.videos?.length || 0), 0);
//             searchDoc.totalPages = searchDoc.videoResults.length;
//             if (searchDoc.isSaved == null) searchDoc.isSaved = false;
// 
//             await searchDoc.save();
//         }
// 
//         console.log(`💾 [MONGODB] Saved ${videos.length} videos for "${query}" page ${page} to consolidated youtube_searches collection (${searchDoc.videoResults.length} pages total)`);
//     } catch (error) {
//         console.error('❌ [MONGODB] Error saving search result:', error);
//     }
// }
// 
// /** Return a cached page from MongoDB without using YouTube API quota. */
// async function getMongoCachedSearchPage(query, page = 1) {
//     const searchDoc = await findBestYouTubeSearchCache(query);
//     if (!searchDoc?.videoResults?.length) return null;
// 
//     const pageResult = searchDoc.videoResults.find((r) => Number(r.page) === Number(page));
//     if (!pageResult?.videos?.length) return null;
// 
//     const videos = filterAccessibleYouTubeVideos(pageResult.videos);
// 
//     if (!videos.length) return null;
// 
//     return {
//         success: true,
//         videos,
//         resultType: pageResult.resultType || 'MULTI',
//         isMock: false,
//         page: Number(page),
//         nextPageToken: pageResult.nextPageToken || null,
//         fromCache: true,
//         cacheSource: 'mongodb-server',
//         searchType: 'search',
//         totalPages: searchDoc.videoResults.length
//     };
// }
// 
// async function getCachedOrFetch(cacheKey, fetchFunction, quotaCost) {
//     // Check cache first
//     const cached = youtubeCache.get(cacheKey);
//     if (cached) {
//         console.log('✓ Cache HIT for:', cacheKey);
//         return { ...cached, fromCache: true };
//     }
// 
//     resetQuotaIfNeeded();
// 
//     // Never hard-block forever on a local exceeded latch — Google may have reset,
//     // or the flag may be a false positive. Always attempt the API; clear the latch
//     // after a successful call. Empty Mongo history must not prevent live searches.
//     if (googleQuotaExceeded) {
//         const markedAt = googleQuotaExceededAt ? Date.parse(googleQuotaExceededAt) : 0;
//         const ageMs = markedAt ? Date.now() - markedAt : Infinity;
//         if (ageMs > 12 * 60 * 60 * 1000) {
//             console.warn(
//                 `⚠️ [QUOTA] Clearing stale googleQuotaExceeded flag (>${Math.round(ageMs / 3600000)}h old) — retrying YouTube API`
//             );
//             googleQuotaExceeded = false;
//             googleQuotaExceededAt = null;
//             saveQuotaData();
//         } else {
//             console.warn(
//                 '⚠️ [QUOTA] googleQuotaExceeded is set — still attempting YouTube API to verify'
//             );
//         }
//     }
// 
//     // Check if we have enough quota
//     if (getRemainingQuota() < quotaCost && !googleQuotaExceeded) {
//         throw new Error(`Quota exceeded: ${dailyQuotaUsed}/10000 calls used. Resets at ${quotaResetTime.toISOString()}`);
//     }
// 
//     // EMERGENCY: Block API calls only when very close to limit (>90% = 9000 quota)
//     // Skip this soft block when we are probing after a googleQuotaExceeded latch.
//     if (dailyQuotaUsed > 9000 && !googleQuotaExceeded) {
//         console.warn(`🚨 [QUOTA-EMERGENCY] Blocking API call - usage critically high: ${dailyQuotaUsed}/10000`);
//         throw new Error(`Emergency quota conservation: ${dailyQuotaUsed}/10000 calls used. Daily limit nearly reached.`);
//     }
// 
//     // WARNING: Log warnings at 80% and 90% but don't block
//     if (dailyQuotaUsed > 8000 && dailyQuotaUsed <= 9000) {
//         console.warn(`⚠️ [QUOTA-WARNING] High usage: ${dailyQuotaUsed}/10000 (${Math.round(dailyQuotaUsed/100)}%)`);
//     }
// 
//     // Check for pending identical request (deduplication)
//     if (pendingRequests.has(cacheKey)) {
//         console.log('⏳ Deduplicating request:', cacheKey);
//         return await pendingRequests.get(cacheKey);
//     }
// 
//     // Execute request
//     const promise = fetchFunction();
//     pendingRequests.set(cacheKey, promise);
// 
//     try {
//         const result = await promise;
//         trackQuotaUsage(quotaCost, `API-${cacheKey}`);
// 
//         if (googleQuotaExceeded) {
//             console.log('✓ [QUOTA] YouTube API succeeded — clearing googleQuotaExceeded latch');
//             googleQuotaExceeded = false;
//             googleQuotaExceededAt = null;
//             saveQuotaData();
//         }
// 
//         // Cache successful results
//         if (result && result.success) {
//             youtubeCache.set(cacheKey, result);
//             console.log('✓ Cached result for:', cacheKey);
//         }
// 
//         return result;
//     } catch (error) {
//         console.error('❌ [CACHE-FETCH] YouTube API request failed for key:', cacheKey);
//         console.error('❌ [CACHE-FETCH] Error details:', {
//             message: error.message,
//             stack: error.stack?.split('\n').slice(0, 5).join('\n'), // First 5 lines of stack
//             code: error.code,
//             status: error.status,
//             statusText: error.statusText,
//             quotaUsed: dailyQuotaUsed,
//             quotaCost: quotaCost
//         });
//         throw error; // Propagate the actual error instead of returning null
//     } finally {
//         pendingRequests.delete(cacheKey);
//     }
// }
// 
// app.post('/api/youtube/search', async (req, res) => {
//     const { query = '', type = 'search', page = 1 } = req.body;
//     console.log('YouTube Search POST body:', req.body);
//     console.log('Query received:', query, '| Type received:', type, '| Page:', page);
// 
//     // Real YouTube API with caching and optimization
//     if (!process.env.GOOGLE_API_KEY) {
//         console.log('⚠️ No API key available');
//         return res.status(500).json({
//             success: false,
//             error: 'YouTube API key not configured',
//             videos: [],
//             isMock: false
//         });
//     }
// 
//     const cacheKey = generateCacheKey(query, type, page, req.body.pageToken);
// 
//     if (type === 'play') {
//         // SINGLE video search with optimization
//         try {
//             const result = await getCachedOrFetch(cacheKey, async () => {
//                 console.log('🔍 Real API: Searching for single video:', query);
// 
//                 const searchResponse = await youtubeSearchList({
//                     part: ['snippet'],
//                     q: query,
//                     maxResults: 1,
//                     type: 'video'
//                 });
// 
//                 if (!searchResponse?.data?.items?.length) {
//                     return { success: false, videos: [], error: 'No videos found for this query' };
//                 }
// 
//                 const videoIds = searchResponse.data.items.map(item => item.id.videoId);
// 
//                 // Get full video details in single batch call
//                 const videoDetails = await youtube.videos.list({
//                     part: ['snippet', 'contentDetails', 'status'],
//                     id: videoIds.join(',')
//                 });
// 
//                 const videos = filterAccessibleYouTubeVideos(
//                     (videoDetails.data.items || []).map((video) => {
//                         const privacy = video.status?.privacyStatus;
//                         const upload = video.status?.uploadStatus;
//                         if (privacy === 'private') return null;
//                         if (upload && upload !== 'processed' && upload !== 'uploaded') return null;
//                         const thumbnail = pickYouTubeThumbnail(video.snippet, video.id);
//                         if (!thumbnail) return null;
//                         return {
//                             id: video.id,
//                             title: video.snippet.title,
//                             description: video.snippet.description,
//                             channelTitle: video.snippet.channelTitle,
//                             channelId: video.snippet.channelId || '',
//                             publishedAt: video.snippet.publishedAt,
//                             duration: video.contentDetails.duration,
//                             thumbnail,
//                             privacyStatus: privacy || 'public',
//                             uploadStatus: upload || 'processed',
//                         };
//                     }).filter(Boolean)
//                 );
// 
//                 // NOTE: MongoDB saving is now OPTIONAL - only happens when user clicks SAVE button
//                 console.log(`🎬 [SEARCH] Single video result saved to localStorage only - use SAVE button to persist to MongoDB`);
// 
//                 return {
//                     success: true,
//                     videos,
//                     resultType: 'SINGLE',
//                     isMock: false
//                 };
//             }, 101); // search.list (100) + videos.list (1)
// 
//             return res.json({
//                 ...result,
//                 quota: {
//                     used: dailyQuotaUsed,
//                     limit: 10000
//                 }
//             });
//         } catch (error) {
//             console.error('YouTube API error for single video search:', error);
// 
//             // Check for quota exceeded error
//             if (error.message && error.message.includes('quota') && error.message.includes('exceeded')) {
//                 console.error('🚫 [QUOTA-EXCEEDED] YouTube API quota limit reached');
//                 return res.status(403).json({
//                     success: false,
//                     error: 'YouTube API quota limit reached',
//                     quotaExceeded: true,
//                     details: sanitizeYouTubeError(error),
//                     videos: [],
//                     isMock: false
//                 });
//             }
// 
//             return res.status(500).json({
//                 success: false,
//                 error: 'YouTube API request failed',
//                 details: sanitizeYouTubeError(error),
//                 videos: [],
//                 isMock: false
//             });
//         }
//     }
// 
//     if (type === 'search' || type === 'channel') {
//         // MULTI video search with optimization
//         const perPage = 12;
//         const pageNum = Math.max(1, Number(page) || 1);
//         const clientPageToken = req.body.pageToken || null;
// 
//         // Declare quotaCostMultiplier outside the callback so it's accessible
//         let quotaCostMultiplier = 1; // Track actual API calls made
// 
//         // MongoDB page cache BEFORE any YouTube API / quota spend
//         if (type === 'search') {
//             try {
//                 const mongoHit = await getMongoCachedSearchPage(query, pageNum);
//                 if (mongoHit) {
//                     console.log(`✓ [MONGODB] Serving page ${pageNum} for "${query}" — no API quota used`);
//                     // Warm in-memory cache too
//                     try {
//                         youtubeCache.set(cacheKey, { ...mongoHit, fromCache: true });
//                     } catch { /* ignore */ }
//                     return res.json({
//                         ...mongoHit,
//                         quota: {
//                             used: dailyQuotaUsed,
//                             limit: 10000
//                         }
//                     });
//                 }
//                 const emptyShell = await findYouTubeSearchMeta(query);
//                 if (emptyShell && !(emptyShell.videoResults || []).some((p) => p?.videos?.length)) {
//                     console.warn(
//                         `⚠️ [MONGODB] History shell for "${query}" has no cached video pages — will try YouTube API`
//                     );
//                 }
//             } catch (mongoErr) {
//                 console.warn('⚠️ [MONGODB] Lookup failed, continuing to API:', mongoErr.message);
//             }
//         }
// 
//         try {
//             const result = await getCachedOrFetch(cacheKey, async () => {
//                 console.log(`🔍 Real API: ${type} search:`, query, 'page:', pageNum);
// 
//                 let channelId = null;
//                 if (type === 'channel') {
//                     const channelLookup = await youtubeSearchList({
//                         part: ['snippet'],
//                         q: query,
//                         maxResults: 1,
//                         type: 'channel'
//                     });
//                     quotaCostMultiplier++;
//                     channelId = channelLookup?.data?.items?.[0]?.id?.channelId;
//                     if (!channelId) {
//                         return { success: false, videos: [], error: `Channel not found for "${query}"` };
//                     }
//                 }
// 
//                 const buildSearchParams = (token) => {
//                     const params = {
//                         part: ['snippet'],
//                         maxResults: perPage,
//                         type: 'video'
//                     };
//                     if (token) params.pageToken = token;
//                     if (channelId) {
//                         params.channelId = channelId;
//                     } else {
//                         params.q = query;
//                     }
//                     return params;
//                 };
// 
//                 let pageToken = clientPageToken;
//                 let searchResponse = null;
// 
//                 if (pageNum > 1) {
//                     if (!pageToken) {
//                         const prevPageCacheKey = generateCacheKey(query, type, pageNum - 1);
//                         const prevPageCache = youtubeCache.get(prevPageCacheKey);
// 
//                         if (prevPageCache && prevPageCache.nextPageToken) {
//                             pageToken = prevPageCache.nextPageToken;
//                             console.log(`💰 [QUOTA-EFFICIENT] Using server cached pageToken from page ${pageNum - 1} for page ${pageNum}`);
//                         }
//                     } else {
//                         console.log(`💰 [QUOTA-EFFICIENT] Using client-provided pageToken for page ${pageNum}`);
//                     }
// 
//                     if (!pageToken) {
//                         console.log(`💸 [QUOTA-EXPENSIVE] No pageToken found, building up to page ${pageNum}...`);
//                         let currentPage = 1;
//                         let response = await youtubeSearchList(buildSearchParams(null));
//                         quotaCostMultiplier++;
// 
//                         while (currentPage < pageNum && response.data.nextPageToken) {
//                             pageToken = response.data.nextPageToken;
//                             response = await youtubeSearchList(buildSearchParams(pageToken));
//                             quotaCostMultiplier++;
//                             currentPage++;
//                         }
// 
//                         if (currentPage === pageNum && response?.data?.items?.length) {
//                             searchResponse = response;
//                             console.log(`💸 [QUOTA-EXPENSIVE] Reached page ${pageNum} during build-up (${quotaCostMultiplier} search calls)`);
//                         } else if (currentPage < pageNum) {
//                             return {
//                                 success: false,
//                                 videos: [],
//                                 error: `Only ${currentPage} page(s) available for this query`
//                             };
//                         }
//                     }
//                 }
// 
//                 if (!searchResponse) {
//                     try {
//                         console.log('🔍 [YOUTUBE-API] Making search request with pageToken:', pageToken || 'none');
//                         searchResponse = await youtubeSearchList(buildSearchParams(pageToken));
//                         if (pageNum > 1) quotaCostMultiplier++;
//                     } catch (tokenError) {
//                         if (pageToken && pageNum > 1) {
//                             console.warn('⚠️ [YOUTUBE-API] pageToken failed, rebuilding from page 1:', sanitizeYouTubeError(tokenError));
//                             pageToken = null;
//                             let currentPage = 1;
//                             let response = await youtubeSearchList(buildSearchParams(null));
//                             quotaCostMultiplier++;
// 
//                             while (currentPage < pageNum && response.data.nextPageToken) {
//                                 pageToken = response.data.nextPageToken;
//                                 response = await youtubeSearchList(buildSearchParams(pageToken));
//                                 quotaCostMultiplier++;
//                                 currentPage++;
//                             }
// 
//                             if (currentPage === pageNum && response?.data?.items?.length) {
//                                 searchResponse = response;
//                             } else {
//                                 throw tokenError;
//                             }
//                         } else {
//                             throw tokenError;
//                         }
//                     }
//                 }
// 
//                 console.log('🔍 [YOUTUBE-API] Search response received:', {
//                     hasData: !!searchResponse?.data,
//                     hasItems: !!searchResponse?.data?.items,
//                     itemsCount: searchResponse?.data?.items?.length || 0,
//                     nextPageToken: !!searchResponse?.data?.nextPageToken
//                 });
// 
//                 if (!searchResponse?.data?.items?.length) {
//                     return { success: false, videos: [], error: 'No videos found for this query' };
//                 }
// 
//                 const videoIds = extractVideoIds(searchResponse.data.items);
//                 console.log('🔍 [YOUTUBE-API] Video IDs extracted:', videoIds.length, 'videos');
// 
//                 if (!videoIds.length) {
//                     return { success: false, videos: [], error: 'No playable videos found for this query' };
//                 }
// 
//                 const videoDetails = await youtube.videos.list({
//                     part: ['snippet', 'contentDetails', 'status'],
//                     id: videoIds.join(',')
//                 });
// 
//                 console.log('🔍 [YOUTUBE-API] Video details response received:', {
//                     hasData: !!videoDetails?.data,
//                     hasItems: !!videoDetails?.data?.items,
//                     itemsCount: videoDetails?.data?.items?.length || 0
//                 });
// 
//                 const videos = mapYouTubeVideosFromSearch(
//                     searchResponse.data.items,
//                     videoDetails?.data?.items
//                 );
// 
//                 console.log(`🎬 [SEARCH] Persisting page ${pageNum} to MongoDB for future cache restores`);
// 
//                 const actualQuotaCost = (quotaCostMultiplier * 100) + 1;
//                 console.log(`💰 [QUOTA] Page ${pageNum} cost: ${actualQuotaCost} quota (${quotaCostMultiplier} search calls + 1 video details call)`);
// 
//                 // Persist so next localStorage miss can restore from Mongo without quota
//                 await saveSearchResultToMongoDB(
//                     query,
//                     pageNum,
//                     videos,
//                     'MULTI',
//                     searchResponse.data.nextPageToken || null,
//                     actualQuotaCost
//                 );
// 
//                 return {
//                     success: true,
//                     videos,
//                     resultType: 'MULTI',
//                     isMock: false,
//                     page: pageNum,
//                     nextPageToken: searchResponse.data.nextPageToken,
//                     fromCache: false,
//                     searchType: type
//                 };
//             }, (quotaCostMultiplier * 100) + 1);
//             return res.json({
//                 ...result,
//                 quota: {
//                     used: dailyQuotaUsed,
//                     limit: 10000
//                 }
//             });
//         } catch (error) {
//             console.error('YouTube API error for multi-search:', error);
// 
//             // Check for quota exceeded error
//             if (isYouTubeQuotaError(error)) {
//                 markGoogleQuotaExceeded('multi-search');
//                 console.error('🚫 [QUOTA-EXCEEDED] YouTube API quota limit reached');
//                 return res.status(403).json({
//                     success: false,
//                     error: 'YouTube API quota limit reached',
//                     quotaExceeded: true,
//                     details: sanitizeYouTubeError(error),
//                     videos: [],
//                     isMock: false,
//                     quota: getQuotaStatus()
//                 });
//             }
// 
//             // Prefer Google's real error — empty History is normal for first-time searches
//             // and must not sound like the reason the search is blocked.
//             const apiDetail = sanitizeYouTubeError(error);
//             let note = '';
//             try {
//                 const shell = await findYouTubeSearchMeta(query);
//                 const hasPages = (shell?.videoResults || []).some((p) => p?.videos?.length);
//                 if (shell && !hasPages) {
//                     note =
//                         `History lists “${shell.displayName || query}” with no saved pages yet; ` +
//                         'once the API succeeds, click Save to cache them.';
//                 }
//             } catch { /* ignore */ }
// 
//             return res.status(500).json({
//                 success: false,
//                 error: apiDetail
//                     ? `YouTube API request failed: ${apiDetail}`
//                     : 'YouTube API request failed',
//                 details: apiDetail,
//                 note: note || undefined,
//                 videos: [],
//                 isMock: false,
//                 cacheEmpty: Boolean(note),
//             });
//         }
//     }
// 
//     if (type === 'movies' || type === 'tv') {
//         // Movies & TV search - searches for movies and TV content on YouTube
//         const perPage = 12;
//         const pageNum = Math.max(1, Number(page) || 1);
// 
//         // Calculate quota cost upfront - more conservative for movies/TV
//         let quotaUsed = 101; // Base cost: search.list (100) + videos.list (1)
//         if (pageNum > 1) {
//             // Check if we can use cached pageToken (efficient) or need to build up (expensive)
//             const prevPageCacheKey = generateCacheKey(query, type, pageNum - 1);
//             const prevPageCache = youtubeCache.get(prevPageCacheKey);
// 
//             if (prevPageCache && prevPageCache.nextPageToken) {
//                 // Efficient: Only one additional API call needed
//                 quotaUsed = 101;
//             } else {
//                 // Expensive: Need to build up through all pages
//                 quotaUsed += (pageNum - 1) * 100; // Additional search.list calls for pagination
//             }
//         }
// 
//         try {
//             const result = await getCachedOrFetch(cacheKey, async () => {
//                 console.log('🎬 Real API: Movies & TV search:', query, 'page:', pageNum, 'type:', type);
// 
//                 // Enhanced query for better movie/TV results
//                 let searchQuery = query;
//                 let searchParams = {
//                     part: ['snippet'],
//                     q: searchQuery,
//                     maxResults: perPage,
//                     type: 'video',
//                     order: 'relevance' // Most relevant first for movies/TV
//                 };
// 
//                 if (type === 'movies') {
//                     // FULL-LENGTH MOVIE SEARCH - Optimized for actual movies, not trailers
//                     searchQuery = `${query} full movie complete film`;
//                     searchParams.videoDuration = 'long';     // Only videos longer than 20 minutes
//                     searchParams.videoDefinition = 'high';   // Only HD videos
//                     console.log('🎬 [MOVIES] Using full-length movie search parameters');
//                 } else if (type === 'tv') {
//                     // TV SHOW SEARCH - Optimized for episodes and series
//                     searchQuery = `${query} tv show series episode full episode`;
//                     searchParams.videoDuration = 'medium';   // 4-20 minutes (typical TV episode length)
//                     searchParams.videoDefinition = 'high';   // Only HD videos
//                     console.log('📺 [TV] Using TV episode search parameters');
//                 }
// 
//                 searchParams.q = searchQuery;
// 
//                 // Handle pagination for movies & TV search - SUSTAINABLE VERSION
//                 let currentPageToken = null;
// 
//                 if (pageNum > 1) {
//                     // STEP 1: Check persistent pageToken database first
//                     currentPageToken = await getNextPageToken(query, type, pageNum - 1);
// 
//                     if (currentPageToken) {
//                         console.log(`🎬 [SUSTAINABLE] Using persistent pageToken from database for ${type} page ${pageNum}`);
//                     } else {
//                         // STEP 2: Check in-memory cache as fallback
//                         const prevPageCacheKey = generateCacheKey(query, type, pageNum - 1);
//                         const prevPageCache = youtubeCache.get(prevPageCacheKey);
// 
//                         if (prevPageCache && prevPageCache.nextPageToken) {
//                             currentPageToken = prevPageCache.nextPageToken;
//                             console.log(`🎬 [SUSTAINABLE] Using in-memory cached pageToken for ${type} page ${pageNum}`);
//                         } else {
//                             // STEP 3: Build up efficiently with database storage
//                             console.log(`🎬 [SUSTAINABLE] Building pageToken chain for ${type} "${query}" up to page ${pageNum}`);
// 
//                             let currentPage = 1;
//                             let tempPageToken = null;
// 
//                             // Start from page 1 or the highest page we have stored
//                             const existingTokens = await PageToken.find({ query, searchType: type }).sort({ page: -1 }).limit(1);
//                             if (existingTokens.length > 0) {
//                                 currentPage = existingTokens[0].page + 1;
//                                 tempPageToken = existingTokens[0].nextPageToken;
//                                 console.log(`🎬 [SUSTAINABLE] Resuming from stored page ${existingTokens[0].page} for ${type} search`);
//                             }
// 
//                             // Build up to target page, storing each pageToken
//                             while (currentPage <= pageNum) {
//                                 const tempResponse = await youtubeSearchList({
//                                     ...searchParams,
//                                     pageToken: tempPageToken
//                                 });
// 
//                                 if (!tempResponse.data.items || tempResponse.data.items.length === 0) {
//                                     console.log(`🎬 [SUSTAINABLE] Reached end of results at page ${currentPage} for ${type} search`);
//                                     return {
//                                         success: true,
//                                         videos: [],
//                                         resultType: 'MULTI',
//                                         isMock: false,
//                                         page: pageNum,
//                                         nextPageToken: null,
//                                         contentType: type,
//                                         fromCache: false,
//                                         endOfResults: true
//                                     };
//                                 }
// 
//                                 // Save this pageToken to database for future use
//                                 await savePageToken(query, type, currentPage, tempPageToken, tempResponse.data.nextPageToken);
// 
//                                 if (currentPage === pageNum) {
//                                     currentPageToken = tempPageToken;
//                                     break;
//                                 }
// 
//                                 tempPageToken = tempResponse.data.nextPageToken;
//                                 if (!tempPageToken) {
//                                     console.log(`🎬 [SUSTAINABLE] No more pages available for ${type} search`);
//                                     return {
//                                         success: true,
//                                         videos: [],
//                                         resultType: 'MULTI',
//                                         isMock: false,
//                                         page: pageNum,
//                                         nextPageToken: null,
//                                         contentType: type,
//                                         fromCache: false,
//                                         endOfResults: true
//                                     };
//                                 }
// 
//                                 currentPage++;
//                                 console.log(`🎬 [SUSTAINABLE] Built pageToken for page ${currentPage - 1}, continuing to page ${currentPage}`);
//                             }
//                         }
//                     }
//                 }
// 
//                 // Set the correct pageToken for the final search
//                 searchParams.pageToken = currentPageToken;
//                 const searchResponse = await youtubeSearchList(searchParams);
// 
//                 if (!searchResponse?.data?.items?.length) {
//                     return { success: false, videos: [], error: `No ${type} content found for this query` };
//                 }
// 
//                 const videoIds = extractVideoIds(searchResponse.data.items);
//                 if (!videoIds.length) {
//                     return { success: false, videos: [], error: `No playable ${type} videos found for this query` };
//                 }
// 
//                 const videoDetails = await youtube.videos.list({
//                     part: ['snippet', 'contentDetails', 'status'],
//                     id: videoIds.join(',')
//                 });
// 
//                 const videos = mapYouTubeVideosFromSearch(
//                     searchResponse.data.items,
//                     videoDetails?.data?.items
//                 ).map((video) => ({
//                     ...video,
//                     contentType: type
//                 }));
// 
//                 // NOTE: MongoDB saving is now OPTIONAL - only happens when user clicks SAVE button
//                 // Search results go to localStorage only (temporary)
//                 console.log(`🎬 [SEARCH] Search results saved to localStorage only - use SAVE button to persist to MongoDB`);
// 
//                 // Save pageToken for sustainable pagination
//                 try {
//                     await savePageToken(query, type, pageNum, currentPageToken, searchResponse.data.nextPageToken);
//                     console.log(`🎬 [SUSTAINABLE] Saved pageToken for future pagination`);
//                 } catch (pageTokenError) {
//                     console.error(`🎬 [SUSTAINABLE] Failed to save pageToken:`, pageTokenError);
//                 }
// 
//                 return {
//                     success: true,
//                     videos,
//                     resultType: 'MULTI',
//                     isMock: false,
//                     page: pageNum,
//                     nextPageToken: searchResponse.data.nextPageToken,
//                     contentType: type,
//                     fromCache: false
//                 };
//             }, quotaUsed); // Dynamic quota cost based on pagination
// 
//             return res.json({
//                 ...result,
//                 quota: {
//                     used: dailyQuotaUsed,
//                     limit: 10000
//                 }
//             });
//         } catch (error) {
//             console.error(`YouTube API error for ${type} search:`, error);
// 
//             // Check if it's a quota-related error
//             if (error.message && error.message.includes('Quota exceeded')) {
//                 return res.status(429).json({
//                     success: false,
//                     error: `Quota limit reached for ${type} search`,
//                     details: sanitizeYouTubeError(error),
//                     videos: [],
//                     isMock: false,
//                     quotaExceeded: true,
//                     quota: {
//                         used: dailyQuotaUsed,
//                         limit: 10000,
//                         resetTime: quotaResetTime.toISOString()
//                     }
//                 });
//             }
// 
//             // Check if it's a quota conservation error
//             if (error.message && error.message.includes('quota conservation')) {
//                 return res.status(429).json({
//                     success: false,
//                     error: `Quota conservation active for ${type} search`,
//                     details: sanitizeYouTubeError(error),
//                     videos: [],
//                     isMock: false,
//                     quotaConservation: true,
//                     quota: {
//                         used: dailyQuotaUsed,
//                         limit: 10000,
//                         resetTime: quotaResetTime.toISOString()
//                     }
//                 });
//             }
// 
//             return res.status(500).json({
//                 success: false,
//                 error: `YouTube API request failed (${type} search)`,
//                 details: sanitizeYouTubeError(error),
//                 videos: [],
//                 isMock: false,
//                 quota: {
//                     used: dailyQuotaUsed,
//                     limit: 10000
//                 }
//             });
//         }
//     }
// 
//     // Fallback for unrecognized types
//     return res.json({ success: false, videos: [], resultType: 'NONE', isMock: false });
// });
// 
// Add quota status and cache management endpoints
// app.get('/api/youtube/quota-status', (req, res) => {
//     res.json(getQuotaStatus());
// });
// 
// /** Resolve a channel for in-app player (prefer videoId → UC…, else name search). */
// app.get('/api/youtube/resolve-channel', async (req, res) => {
//     try {
//         const videoId = String(req.query.videoId || '').trim();
//         const q = String(req.query.q || '').trim();
// 
//         // Cheapest path: channelId from an existing video (1 quota unit)
//         if (videoId) {
//             const videoResponse = await youtube.videos.list({
//                 part: ['snippet'],
//                 id: [videoId],
//             });
//             const snip = videoResponse?.data?.items?.[0]?.snippet;
//             const channelId = snip?.channelId || '';
//             if (channelId) {
//                 return res.json({
//                     success: true,
//                     channelId,
//                     channelTitle: snip?.channelTitle || q || channelId,
//                 });
//             }
//         }
// 
//         if (!q) {
//             return res.status(400).json({
//                 success: false,
//                 error: 'q or videoId is required',
//             });
//         }
// 
//         // Already a channel id
//         if (/^UC[\w-]{20,}$/i.test(q)) {
//             return res.json({ success: true, channelId: q, channelTitle: q });
//         }
// 
//         const response = await youtubeSearchList({
//             part: ['snippet'],
//             q,
//             type: 'channel',
//             maxResults: 1,
//         });
//         const item = response?.data?.items?.[0];
//         const channelId = item?.id?.channelId || item?.snippet?.channelId || '';
//         const channelTitle = item?.snippet?.title || q;
//         if (!channelId) {
//             return res.status(404).json({
//                 success: false,
//                 error: 'No YouTube channel found for that name',
//             });
//         }
//         return res.json({ success: true, channelId, channelTitle });
//     } catch (error) {
//         console.error('[youtube/resolve-channel]', error?.message || error);
//         if (isYouTubeQuotaError(error)) {
//             markGoogleQuotaExceeded('resolve-channel');
//             return res.status(403).json({
//                 success: false,
//                 error: 'YouTube API quota exceeded',
//             });
//         }
//         return res.status(500).json({
//             success: false,
//             error: sanitizeYouTubeError(error) || 'Failed to resolve channel',
//         });
//     }
// });
// 
// app.post('/api/youtube/quota-google-exceeded', (req, res) => {
//     markGoogleQuotaExceeded(req.body?.source || 'client');
//     res.json({ success: true, quota: getQuotaStatus() });
// });
// 
// Test YouTube API quota status with minimal API call
// app.post('/api/youtube/test-quota', async (req, res) => {
//     try {
//         console.log('🧪 [QUOTA-TEST] Testing YouTube API quota status...');
// 
//         // Make a minimal YouTube API call to test quota
//         const searchResponse = await youtubeSearchList({
//             part: ['snippet'],
//             q: 'test',
//             maxResults: 1,
//             type: 'video'
//         });
// 
//         if (searchResponse && searchResponse.data && searchResponse.data.items) {
//             console.log('✅ [QUOTA-TEST] YouTube API quota OK');
//             res.json({
//                 success: true,
//                 quotaExceeded: false,
//                 message: 'YouTube API quota is available'
//             });
//         } else {
//             console.log('⚠️ [QUOTA-TEST] Unexpected API response');
//             res.json({
//                 success: false,
//                 quotaExceeded: false,
//                 message: 'Unexpected API response'
//             });
//         }
//     } catch (error) {
//         console.error('❌ [QUOTA-TEST] YouTube API error:', error.message);
// 
//         // Check if error indicates quota exceeded
//         const isQuotaError = error.message.includes('quota') ||
//                             error.message.includes('Quota') ||
//                             error.code === 403 ||
//                             error.status === 403;
// 
//         if (isQuotaError) {
//             markGoogleQuotaExceeded('test-quota');
//             console.log('🚫 [QUOTA-TEST] YouTube API quota limit reached');
//             res.status(403).json({
//                 success: false,
//                 quotaExceeded: true,
//                 error: 'YouTube API quota limit reached',
//                 message: error.message,
//                 quota: getQuotaStatus()
//             });
//         } else {
//             console.log('❌ [QUOTA-TEST] Other API error:', error.message);
//             res.status(500).json({
//                 success: false,
//                 quotaExceeded: false,
//                 error: 'API test failed',
//                 message: error.message
//             });
//         }
//     }
// });
// 
// Admin endpoint to manually set quota usage (for fixing quota tracking)
// app.post('/api/youtube/quota-set', (req, res) => {
//     const { used } = req.body;
// 
//     if (typeof used !== 'number' || used < 0 || used > 10000) {
//         return res.status(400).json({
//             success: false,
//             error: 'Invalid quota usage. Must be a number between 0 and 10000.'
//         });
//     }
// 
//     const oldUsed = dailyQuotaUsed;
//     dailyQuotaUsed = used;
//     if (used < 10000) {
//         googleQuotaExceeded = false;
//         googleQuotaExceededAt = null;
//     }
//     saveQuotaData();
// 
//     console.log(`📊 [QUOTA] Manual quota adjustment: ${oldUsed} → ${dailyQuotaUsed}`);
// 
//     res.json({
//         success: true,
//         message: `Quota usage updated from ${oldUsed} to ${dailyQuotaUsed}`,
//         quota: getQuotaStatus()
//     });
// });
// 
// /api/quota/run-script peeled to platform-service (:4812)
// app.post('/api/quota/run-script', async (req, res) => { … });

// Admin endpoint to manually reset quota (for testing)
// Remaining /api/youtube/* MOVED to media-service (:4805)
// app.post('/api/youtube/quota-reset', (req, res) => {
//     const oldUsed = dailyQuotaUsed;
//     dailyQuotaUsed = 0;
//     quotaResetTime = new Date();
//     quotaResetTime.setDate(quotaResetTime.getDate() + 1); // Set next reset to tomorrow
//     quotaResetTime.setHours(8, 0, 0, 0); // 8 AM
//     saveQuotaData();
// 
//     console.log(`🔄 [QUOTA] Manual quota reset: ${oldUsed} → 0`);
// 
//     res.json({
//         success: true,
//         message: `Quota manually reset from ${oldUsed} to 0`,
//         quota: {
//             used: dailyQuotaUsed,
//             remaining: getRemainingQuota(),
//             total: 10000,
//             percentage: 0,
//             resetTime: quotaResetTime.toISOString()
//         }
//     });
// });
// 
// PageToken management endpoints
// app.get('/api/youtube/pagetokens/:query/:type', async (req, res) => {
//     try {
//         const { query, type } = req.params;
//         const tokens = await PageToken.find({ query, searchType: type }).sort({ page: 1 });
// 
//         res.json({
//             success: true,
//             query,
//             searchType: type,
//             tokens: tokens.map(t => ({
//                 page: t.page,
//                 hasToken: !!t.pageToken,
//                 hasNext: !!t.nextPageToken,
//                 createdAt: t.createdAt,
//                 lastAccessed: t.lastAccessed
//             })),
//             totalPages: tokens.length
//         });
//     } catch (error) {
//         console.error('Error fetching pageTokens:', error);
//         res.status(500).json({ success: false, error: error.message });
//     }
// });
// 
// app.delete('/api/youtube/pagetokens/:query/:type', async (req, res) => {
//     try {
//         const { query, type } = req.params;
//         const result = await PageToken.deleteMany({ query, searchType: type });
// 
//         console.log(`🗑️ [PAGETOKEN] Deleted ${result.deletedCount} pageTokens for ${type} "${query}"`);
// 
//         res.json({
//             success: true,
//             message: `Deleted ${result.deletedCount} pageTokens for ${type} search "${query}"`,
//             deletedCount: result.deletedCount
//         });
//     } catch (error) {
//         console.error('Error deleting pageTokens:', error);
//         res.status(500).json({ success: false, error: error.message });
//     }
// });
// 
// app.post('/api/youtube/clear-cache', (req, res) => {
//     const clearedKeys = youtubeCache.keys().length;
//     youtubeCache.flushAll();
//     res.json({
//         success: true,
//         message: `Cleared ${clearedKeys} cached items`,
//         clearedKeys
//     });
// });
// 
// app.get('/api/youtube/cache-info', (req, res) => {
//     const keys = youtubeCache.keys();
//     const cacheInfo = {
//         totalKeys: keys.length,
//         keys: keys.map(key => ({
//             key,
//             ttl: youtubeCache.getTtl(key) ? new Date(youtubeCache.getTtl(key)).toISOString() : null
//         })),
//         stats: youtubeCache.getStats()
//     };
// 
//     res.json(cacheInfo);
// });
// 
// Admin endpoint to backfill duration data for existing playlist videos
// app.post('/api/youtube/playlists-backfill-duration', async (req, res) => {
//     try {
//         console.log('🔄 [BACKFILL] This endpoint is deprecated. Use client-side backfill instead.');
//         console.log('🔄 [BACKFILL] Go to your browser console and run: backfillPlaylistDurations()');
// 
//         res.json({
//             success: false,
//             message: 'Server-side backfill is deprecated. Use client-side backfill function instead.',
//             instruction: 'Run backfillPlaylistDurations() in browser console'
//         });
//     } catch (error) {
//         console.error('❌ [BACKFILL] Error:', error);
//         res.status(500).json({ error: 'Backfill failed' });
//     }
// });
// 
// New endpoint for client to send cached video data for backfill
// app.post('/api/youtube/playlists-update-durations', async (req, res) => {
//     try {
//         const { updates } = req.body;
//         if (!updates || !Array.isArray(updates)) {
//             return res.status(400).json({ error: 'Invalid updates data' });
//         }
// 
//         const Playlist = require('./models/Playlist');
//         let totalUpdated = 0;
// 
//         console.log(`🔄 [BACKFILL] Processing ${updates.length} video updates from client cache`);
// 
//         for (const update of updates) {
//             const { playlistId, videoId, duration, channelTitle } = update;
// 
//             if (!playlistId || !videoId) continue;
// 
//             const result = await Playlist.updateOne(
//                 {
//                     '_id': playlistId,
//                     'videos.videoId': videoId
//                 },
//                 {
//                     $set: {
//                         'videos.$.duration': duration || '',
//                         'videos.$.channelTitle': channelTitle || ''
//                     }
//                 }
//             );
// 
//             if (result.modifiedCount > 0) {
//                 totalUpdated++;
//                 console.log(`✅ [BACKFILL] Updated ${videoId}: ${duration}`);
//             }
//         }
// 
//         console.log(`🎯 [BACKFILL] Updated ${totalUpdated}/${updates.length} videos with duration data`);
// 
//         res.json({
//             success: true,
//             totalUpdated,
//             totalProcessed: updates.length
//         });
//     } catch (error) {
//         console.error('❌ [BACKFILL] Error:', error);
//         res.status(500).json({ error: 'Backfill update failed' });
//     }
// });
// 
// 
// =====================================================
// PROCESS ERROR HANDLING
// =====================================================

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error(chalk.red('[PROCESS] Uncaught Exception:'), error);
    console.error(chalk.red('[PROCESS] Error stack:'), error.stack);
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error(chalk.red('[PROCESS] Unhandled Rejection at:'), promise);
    console.error(chalk.red('[PROCESS] Reason:'), reason);
    process.exit(1);
});

// =====================================================
// SERVER LISTENER
// =====================================================

// Call the server and port
console.log('[SERVER] Attempting to start server on port:', port);
logger.info('server.listen.attempt', { port });

let httpServer = null;
let isShuttingDown = false;

function listenWithRetry(retriesLeft = 30) {
    // Fresh server each attempt — reusing a failed listen handle on Windows
    // often stays stuck in EADDRINUSE even after close().
    const http = require('http');
    const server = http.createServer(app);
    httpServer = server;

    const onError = (error) => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE' && retriesLeft > 0) {
            logger.warn('server.port.in_use.retry', {
                port,
                retriesLeft,
                message: error.message,
            });
            console.warn(
                chalk.yellow(
                    `[BACKEND] Port ${port} in use — retrying in 1.5s (${retriesLeft} left)...`
                )
            );
            try {
                server.close();
            } catch {
                /* ignore */
            }
            setTimeout(() => listenWithRetry(retriesLeft - 1), 1500);
            return;
        }
        logger.fatal('server.listen.failed', error);
        console.error(chalk.red('[BACKEND] Error starting server:'), error);
        if (error.code === 'EACCES') {
            console.error(chalk.red('[BACKEND] Permission denied. Try using a port number above 1024.'));
        } else if (error.code === 'EADDRINUSE') {
            console.error(chalk.red('[BACKEND] Port is already in use. Try a different port.'));
            console.error(
                chalk.yellow(
                    '[BACKEND] Tip: run `npx kill-port 4800` then `npm run dev` again.'
                )
            );
        } else {
            console.error(chalk.red('[BACKEND] Unexpected error:'), error.message);
            console.error(chalk.red('[BACKEND] Error stack:'), error.stack);
        }
        process.exit(1);
    };

    const onListening = () => {
        server.removeListener('error', onError);
        logger.info('server.listen.ok', {
            port,
            url: `http://localhost:${port}`,
            logDir: logger.dir,
        });
        console.log(chalk.magenta(`[BACKEND] Listening at http://localhost:${port}`));
        console.log(chalk.green('[SERVER] Server started successfully!'));
        console.log(chalk.cyan(`[SERVER] Logs → ${logger.dir}`));
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
}

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('server.shutdown', { signal });
    console.log(`[SERVER] ${signal} received — closing HTTP + Mongo before exit`);
    try {
        if (httpServer) {
            if (typeof httpServer.closeAllConnections === 'function') {
                httpServer.closeAllConnections();
            }
            await new Promise((resolve) => {
                httpServer.close(() => resolve());
                // Don't hang forever if a keep-alive client won't drop
                setTimeout(resolve, 2000);
            });
        }
    } catch (err) {
        logger.error('server.shutdown.http_error', err);
        console.error('[SERVER] Error closing HTTP server:', err.message);
    }
    try {
        await mongoose.connection.close(false);
    } catch (err) {
        logger.error('server.shutdown.mongo_error', err);
        console.error('[SERVER] Error closing Mongo:', err.message);
    }
    process.exit(0);
}

process.once('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
});
process.once('SIGINT', () => {
    void gracefulShutdown('SIGINT');
});
// nodemon restart signal (when supported)
process.once('SIGUSR2', () => {
    void gracefulShutdown('SIGUSR2').then(() => {
        process.kill(process.pid, 'SIGUSR2');
    });
});

listenWithRetry();



// =====================================================
// END OF Server.js FILE v2
// =====================================================

