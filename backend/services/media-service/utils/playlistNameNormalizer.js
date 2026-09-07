/*
  PLAYLIST-NAME-NORMALIZER.JS
  Shared logic for comparing playlist names (server + merge scripts).
  Keep in sync with public/utils/playlistNameNormalizer.js
*/

function stripPlaylistPrefixes(name) {
  if (!name) return '';
  let cleaned = name
    .replace(/^youtube\s+search\s+/i, '')
    .replace(/^youtube\s+channel\s+/i, '')
    .replace(/^youtube\s+movies?\s+/i, '')
    .replace(/^youtube\s+tv\s+/i, '')
    .replace(/^youtube\s+/i, '')
    .replace(/^search\s+/i, '')
    .replace(/^channel\s+/i, '')
    .replace(/^movies?\s+/i, '')
    .replace(/^tv\s+/i, '')
    .trim();
  if (!cleaned) cleaned = name.trim();
  return cleaned.replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function detectSearchTypeFromName(name) {
  if (!name) return 'search';
  const lowerName = name.toLowerCase();
  if (lowerName.includes('youtube channel') || lowerName.startsWith('channel ')) {
    return 'channel';
  }
  if (
    lowerName.includes('youtube movie') ||
    lowerName.includes('youtube film') ||
    lowerName.startsWith('movie ') ||
    lowerName.startsWith('film ')
  ) {
    return 'movies';
  }
  if (
    lowerName.includes('youtube tv') ||
    lowerName.includes('youtube television') ||
    lowerName.includes('youtube series') ||
    lowerName.includes('youtube show') ||
    lowerName.startsWith('tv ') ||
    lowerName.startsWith('television ') ||
    lowerName.startsWith('series ') ||
    lowerName.startsWith('show ')
  ) {
    return 'tv';
  }
  return 'search';
}

function toHumanReadable(cleaned) {
  return cleaned.replace(/\b\w/g, (l) => l.toUpperCase());
}

/** Exact string shown in the playlist list (before lowercasing for compare). */
function getPlaylistVisibleName(name) {
  if (!name) return '';
  const type = detectSearchTypeFromName(name);
  let cleaned = stripPlaylistPrefixes(name);
  if (!cleaned) cleaned = name.trim();
  const humanReadable = toHumanReadable(cleaned);
  switch (type) {
    case 'channel':
      return `${humanReadable} (ch)`;
    case 'movies':
      return `${humanReadable} (mv)`;
    case 'tv':
      return `${humanReadable} (tv)`;
    default:
      return humanReadable;
  }
}

/** Key used for duplicate detection — matches visible label, case-insensitive. */
function getPlaylistVisibleNameKey(name) {
  return getPlaylistVisibleName(name).toLowerCase().trim();
}

/** @deprecated Use getPlaylistVisibleNameKey — kept for compatibility */
function getPlaylistDisplayComparisonKey(name) {
  return getPlaylistVisibleNameKey(name);
}

module.exports = {
  stripPlaylistPrefixes,
  detectSearchTypeFromName,
  getPlaylistVisibleName,
  getPlaylistVisibleNameKey,
  getPlaylistDisplayComparisonKey
};
