/*
  PAGETOKEN.JS
  Version: 2.0
  AppName: MultiChat_Chatty [v2.0]
  Updated: 12/31/2025 @10:00AM
  Created by Paul Welby
*/

const mongoose = require('mongoose');

const pageTokenSchema = new mongoose.Schema({
    query: {
        type: String,
        required: true,
        index: true
    },
    searchType: {
        type: String,
        required: true,
        enum: ['search', 'channel', 'movies', 'tv'],
        default: 'search'
    },
    page: {
        type: Number,
        required: true,
        min: 1
    },
    pageToken: {
        type: String,
        required: true
    },
    nextPageToken: {
        type: String,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 2592000 // 30 days TTL
    },
    lastAccessed: {
        type: Date,
        default: Date.now
    }
});

// Compound index for efficient lookups
pageTokenSchema.index({ query: 1, searchType: 1, page: 1 }, { unique: true });

module.exports = mongoose.model('PageToken', pageTokenSchema); 