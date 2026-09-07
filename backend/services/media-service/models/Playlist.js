/*
  PLAYLIST.JS
  Version: 2.0
  AppName: MultiChat_Chatty [v2.0]
  Updated: 12/31/2025 @10:00AM
  Created by Paul Welby
*/

const mongoose = require('mongoose');

const VideoSchema = new mongoose.Schema({
  videoId: { type: String, required: true },
  title: { type: String, required: true },
  thumbnail: { type: String, required: true },
  duration: { type: String, default: '' },
  channelTitle: { type: String, default: '' },
  // No Date.now default — mongoose would re-stamp every video on playlist.save()
  // when addedAt was missing, which destroyed "Most Recent" ordering.
  addedAt: { type: Date }
});

const PlaylistSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  displayKey: { type: String, index: true },
  videos: [VideoSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  /** Set only when a video is explicitly added/moved — used for "Most Recent". */
  lastVideoAddedAt: { type: Date },
  /** Set when user plays/opens a playlist — preferred for "Most Recent". */
  lastAccessedAt: { type: Date },
});

PlaylistSchema.index({ userId: 1, displayKey: 1 }, { unique: true, sparse: true });
PlaylistSchema.index({ userId: 1, updatedAt: -1 });
PlaylistSchema.index({ userId: 1, lastVideoAddedAt: -1 });
PlaylistSchema.index({ userId: 1, lastAccessedAt: -1 });

// Only bump updatedAt for new playlists or video list changes.
// Cosmetic name/displayKey fixes must NOT rewrite updatedAt.
PlaylistSchema.pre('save', function (next) {
  if (this.isNew || this.isModified('videos')) {
    this.updatedAt = new Date();
  }
  next();
});

module.exports = mongoose.model('Playlist', PlaylistSchema);
