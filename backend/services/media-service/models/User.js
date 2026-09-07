/*
  USER.JS
  Version: 2.1
  AppName: MultiChat_Chatty [v2.1]
  Updated: 07/26/2026
  Created by Paul Welby
*/

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true }, // Store hashed password (random for Auth0 users)
  role: { type: String, enum: ['user', 'admin', 'superadmin'], default: 'user' },
  isActive: { type: Boolean, default: true },
  oneTimeCode: { type: String, default: null }, // For SuperAdmin unlock
  /** Mongo scope for jokes / YouTube / playlists / personal info */
  dataKey: { type: String, default: null, index: true },
  /** Auth0 subject (e.g. google-oauth2|…) when signed in socially */
  auth0Id: { type: String, default: null, index: true },
  /** 'auth0' | 'google' | null for password accounts */
  authProvider: { type: String, default: null },
  created: { type: Date, default: Date.now },
  updated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
