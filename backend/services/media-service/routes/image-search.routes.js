/**
 * Image search + proxy peel — moved from monolith server.js into media-service.
 * Mounts: /api/image-search, /api/google-image-search, /api/image-proxy
 */
const express = require('express');
const axios = require('axios');

const router = express.Router();

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

router.get('/image-proxy', async (req, res) => {
    const url = req.query.url;
    if (!url || !isAllowedImageProxyUrl(url)) {
        return res.status(400).send('Invalid image URL');
    }
    try {
        const entry = await fetchImageToCache(url);
        res.set('Content-Type', entry.contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(entry.buffer);
    } catch (err) {
        console.warn('[IMAGE PROXY] fetch failed:', err.message);
        res.status(502).send('Failed to fetch image');
    }
});

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

router.get('/image-search', imageSearchHandler);
router.get('/google-image-search', imageSearchHandler);

module.exports = router;
