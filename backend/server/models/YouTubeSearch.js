/*
  YOUTUBESEARCH.JS
  Version: 2.0
  AppName: MultiChat_Chatty [v2.0]
  Updated: 12/31/2025 @10:00AM
  Created by Paul Welby
*/

const mongoose = require('mongoose');

// Video Schema for storing individual video results
const VideoSchema = new mongoose.Schema({
    id: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    channelTitle: { type: String, required: true },
    channelId: { type: String, default: '' },
    publishedAt: { type: String, required: true },
    duration: { type: String, default: '' },
    thumbnail: { type: String, required: true }
});

// Unified YouTube Search Schema - combines search queries, metadata, and results
const youtubeSearchSchema = new mongoose.Schema({
    query: { type: String, required: true },
    userId: { type: String, required: true, default: 'default-user' },
    displayName: String, // Cleaned display name (without "youtube search" prefix)
    totalPages: { type: mongoose.Schema.Types.Mixed, default: 1 }, // Allow both Number and String (e.g., "many")
    lastSearched: { type: Date, default: Date.now, required: true }, // Last time this query was searched/saved
    dateCreated: { type: Date, default: Date.now, required: true }, // When this search was first saved
    cacheKeys: [String], // Array of localStorage cache keys for this query
    videoCount: { type: Number, default: 0 }, // Number of videos found
    searchMetadata: {
        searchType: { type: String, default: 'search' }, // 'search' or 'play'
        lastPageViewed: { type: Number, default: 1 },
        totalResults: { type: mongoose.Schema.Types.Mixed, default: 0 } // Allow both Number and String (e.g., "many")
    },
    // Store video results by page for caching
    videoResults: [{
        page: { type: Number, required: true, default: 1 },
        videos: [VideoSchema],
        resultType: { type: String, enum: ['SINGLE', 'MULTI', 'CHANNEL'], default: 'MULTI' },
        nextPageToken: { type: String, default: null },
        totalResults: { type: Number, default: 0 },
        timestamp: { type: Date, default: Date.now },
        apiQuotaUsed: { type: Number, default: 101 }
    }],
    // Legacy fields for backward compatibility
    isSaved: { type: Boolean, default: true }, // From YoutubeHistory
    timestamp: { type: Date } // From YoutubeHistory
}, {
    collection: 'youtube_searches'
});

// Add indexes for faster lookups
youtubeSearchSchema.index({ userId: 1, query: 1 });
youtubeSearchSchema.index({ userId: 1, lastSearched: -1 });

module.exports = mongoose.model('YouTubeSearch', youtubeSearchSchema); 