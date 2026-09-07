/*
  PERSONALINFO.JS
  Version: 2.0
  AppName: MultiChat_Chatty [v2.0]
  Updated: 12/31/2025 @10:00AM
  Created by Paul Welby
*/

const mongoose = require('mongoose');

// Personal Info Schema - for storing conversation history and user data
const personalInfoSchema = new mongoose.Schema({
    userId: String,
    sessionId: String,
    sessionType: String,
    sessionVersion: String,
    type: String,
    value: String,
    timestamp: { type: Date, default: Date.now },
    created: { type: Date, default: Date.now },
    updated: { type: Date, default: Date.now }
}, {
    collection: 'conversation_history',
    strict: false  // Allow flexibility with existing data
});

// Add indexes for faster lookups
personalInfoSchema.index({ sessionId: 1, type: 1 });

module.exports = mongoose.model('PersonalInfo', personalInfoSchema); 