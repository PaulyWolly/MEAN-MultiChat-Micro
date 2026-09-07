/*
  PLAYLISTS.ROUTES.JS
  Version: 2.0
  AppName: MultiChat_Chatty [v2.0]
  Updated: 12/31/2025 @10:00AM
  Created by Paul Welby
*/

const express = require('express');
const Playlist = require('../models/Playlist');
const mongoose = require('mongoose');
const { getPlaylistVisibleName, getPlaylistVisibleNameKey } = require('../utils/playlistNameNormalizer');
const { requireDataScope } = require('../middleware/auth');

const router = express.Router();

function findDuplicatePlaylist(playlists, name, excludeId = null) {
  const targetKey = getPlaylistVisibleNameKey(name);
  if (!targetKey) return null;
  return playlists.find((pl) => {
    if (excludeId && pl._id.toString() === excludeId) return false;
    const plKey = pl.displayKey || getPlaylistVisibleNameKey(pl.name);
    return plKey === targetKey;
  }) || null;
}

async function mergeDuplicatePlaylists(userId) {
  const playlists = await Playlist.find({ userId });
  const groups = {};

  playlists.forEach((pl) => {
    const key = pl.displayKey || getPlaylistVisibleNameKey(pl.name);
    if (!key) return;
    if (!groups[key]) groups[key] = [];
    groups[key].push(pl);
  });

  let mergedSets = 0;
  for (const group of Object.values(groups)) {
    if (group.length < 2) {
      const solo = group[0];
      const canonicalName = getPlaylistVisibleName(solo.name);
      const displayKey = getPlaylistVisibleNameKey(solo.name);
      const patch = {};
      if (solo.name !== canonicalName) patch.name = canonicalName;
      if (solo.displayKey !== displayKey) patch.displayKey = displayKey;
      // updateOne avoids pre('save') and must not touch updatedAt
      if (Object.keys(patch).length > 0) {
        await Playlist.updateOne({ _id: solo._id }, { $set: patch });
      }
      continue;
    }

    group.sort((a, b) => {
      const countDiff = (b.videos?.length || 0) - (a.videos?.length || 0);
      if (countDiff !== 0) return countDiff;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    const keeper = group[0];
    const toMerge = group.slice(1);
    const displayKey = getPlaylistVisibleNameKey(keeper.name);
    const canonicalName = getPlaylistVisibleName(keeper.name);
    const seenVideoIds = new Set(keeper.videos.map((v) => v.videoId));
    let videosAdded = 0;

    for (const pl of toMerge) {
      for (const video of pl.videos) {
        if (!seenVideoIds.has(video.videoId)) {
          keeper.videos.push(video);
          seenVideoIds.add(video.videoId);
          videosAdded += 1;
        }
      }
      await Playlist.deleteOne({ _id: pl._id });
    }

    // Plain update avoids mongoose re-defaulting missing video.addedAt on save()
    const plainVideos = (keeper.videos || []).map((v) => ({
      videoId: v.videoId,
      title: v.title,
      thumbnail: v.thumbnail,
      duration: v.duration || '',
      channelTitle: v.channelTitle || '',
      ...(v.addedAt ? { addedAt: v.addedAt } : {}),
      ...(v._id ? { _id: v._id } : {}),
    }));
    const $set = {
      name: canonicalName,
      displayKey,
      videos: plainVideos,
    };
    if (videosAdded > 0) {
      $set.updatedAt = new Date();
    }
    await Playlist.updateOne({ _id: keeper._id }, { $set });
    mergedSets++;
    console.log(
      `[PLAYLISTS] Merged ${group.length} playlists into "${canonicalName}" (${plainVideos.length} videos)`
    );
  }

  return mergedSets;
}

/**
 * A bulk mongoose save stamped many playlists with the same updatedAt/addedAt.
 * Detect those clusters and restore a sane activity time; backfill lastVideoAddedAt.
 */
async function repairPlaylistActivityTimestamps(userId) {
  const playlists = await Playlist.find({ userId }).lean();
  if (!playlists.length) return 0;

  const secondCounts = new Map();
  for (const p of playlists) {
    const key = p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 19) : '';
    if (!key) continue;
    secondCounts.set(key, (secondCounts.get(key) || 0) + 1);
  }

  let repaired = 0;
  for (const p of playlists) {
    const key = p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 19) : '';
    const isMassStamp = key && (secondCounts.get(key) || 0) >= 5;
    const patch = {};

    if (isMassStamp) {
      // Revert bulk-stamped updatedAt to createdAt (real adds set lastVideoAddedAt going forward)
      const restored = p.createdAt ? new Date(p.createdAt) : new Date(0);
      patch.updatedAt = restored;
    }

    if (!p.lastVideoAddedAt) {
      if (!isMassStamp && p.updatedAt) {
        patch.lastVideoAddedAt = new Date(p.updatedAt);
      } else if (p.createdAt) {
        // Mass-stamped: don't treat bulk save as a real video add
        patch.lastVideoAddedAt = new Date(p.createdAt);
      }
    }

    if (Object.keys(patch).length > 0) {
      await Playlist.updateOne({ _id: p._id }, { $set: patch });
      repaired += 1;
    }
  }
  if (repaired) {
    console.log(`[PLAYLISTS] Repaired activity timestamps on ${repaired} playlists for ${userId}`);
  }
  return repaired;
}

console.log('>>>[PLAYLISTS.ROUTES] playlists.routes.js loaded');

function isMongoUsable() {
  // 1 = connected. Also allow when the native driver handle is still present
  // after a transient disconnect (readyState can stick at 0 while DB still works).
  return (
    mongoose.connection.readyState === 1 ||
    Boolean(mongoose.connection.db)
  );
}

async function waitForMongo(ms = 20000) {
  if (isMongoUsable()) return true;
  // readyState 2 = connecting — wait instead of racing a second connect()
  if (mongoose.connection.readyState === 2) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(isMongoUsable());
      }, ms);
      const onReady = () => {
        cleanup();
        resolve(true);
      };
      const cleanup = () => {
        clearTimeout(timer);
        mongoose.connection.off('connected', onReady);
        mongoose.connection.off('open', onReady);
      };
      mongoose.connection.once('connected', onReady);
      mongoose.connection.once('open', onReady);
    });
  }
  return false;
}

async function ensureMongoConnection() {
  if (isMongoUsable()) return true;
  if (await waitForMongo()) return true;
  const uri = process.env.MONGODB_URI;
  if (!uri) return false;
  try {
    const { resolveMongoUri } = require('../mongoDnsFallback');
    const mongoUri = await resolveMongoUri(uri);
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
    });
    return isMongoUsable();
  } catch (err) {
    console.error('[PLAYLISTS] Mongo reconnect failed:', err.message);
    return false;
  }
}

/**
 * Authenticate, then scope every query to the caller's own playlists.
 *
 * The owner is taken from the verified token. It used to come from a
 * ?sessionId= query parameter, which meant anyone who knew another account's
 * key could read and delete that account's playlists.
 */
const requireAuth = (req, res, next) => {
  requireDataScope(req, res, async () => {
    if (!isMongoUsable()) {
      const ok = await ensureMongoConnection();
      if (!ok) {
        console.error(
          'MongoDB not connected. Current state:',
          mongoose.connection.readyState
        );
        return res.status(500).json({
          error: 'Database not connected',
          detail:
            'MongoDB Atlas is unreachable (often DNS). Server is retrying — wait a few seconds and reopen Playlists.',
        });
      }
    }

    req.userId = req.scopeKey;
    next();
  });
};

// List all playlists for the user
router.get('/', requireAuth, async (req, res) => {
  console.log('>>>>>[GET] /api/playlists called for user:', req.userId);
  console.log('>>>>>[GET] MongoDB connection state:', mongoose.connection.readyState);
  try {
    await mergeDuplicatePlaylists(req.userId);
    await repairPlaylistActivityTimestamps(req.userId);
    const playlists = await Playlist.find({ userId: req.userId }).sort({
      lastVideoAddedAt: -1,
      updatedAt: -1,
    });
    console.log('>>>>>[GET] /api/playlists found playlists:', playlists.length);
    res.json({ success: true, playlists });
  } catch (error) {
    console.error('Error in GET /api/playlists:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch playlists', 
      details: error.message,
      userId: req.userId,
      dbState: mongoose.connection.readyState
    });
  }
});

// Create a new playlist
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Playlist name required' });

    const existingPlaylists = await Playlist.find({ userId: req.userId });
    const duplicate = findDuplicatePlaylist(existingPlaylists, name);
    if (duplicate) {
      return res.status(409).json({
        error: 'DUPLICATE_NAME',
        message: 'A playlist with this name already exists',
        playlist: duplicate
      });
    }

    const canonicalName = getPlaylistVisibleName(name);
    const displayKey = getPlaylistVisibleNameKey(name);
    const playlist = new Playlist({
      userId: req.userId,
      name: canonicalName,
      displayKey,
      videos: []
    });
    await playlist.save();
    res.json({ success: true, playlist });
  } catch (error) {
    console.error('[PLAYLISTS] create failed:', error?.message || error);
    if (error.code === 11000) {
      const existing = await Playlist.findOne({
        userId: req.userId,
        displayKey: getPlaylistVisibleNameKey(req.body?.name),
      });
      return res.status(409).json({
        error: 'DUPLICATE_NAME',
        message: 'A playlist with this name already exists',
        playlist: existing
      });
    }
    res.status(500).json({
      error: 'Failed to create playlist',
      message: error.message || 'Failed to create playlist',
    });
  }
});

// Add a video to a playlist
router.post('/:playlistId/videos', requireAuth, async (req, res) => {
  try {
    const { videoId, title, duration, channelTitle } = req.body;
    let { thumbnail } = req.body;
    if (!videoId || !title) {
      return res.status(400).json({ error: 'Missing video data' });
    }
    // Always have a thumb so auto-create isn't blocked when the search card
    // omitted one — fall back to the standard YouTube hqdefault URL.
    if (!thumbnail) {
      thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }

    const playlist = await Playlist.findOne({ 
      _id: req.params.playlistId, 
      userId: req.userId 
    });
    
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Check for duplicate videoId
    if (playlist.videos.some(v => v.videoId === videoId)) {
      return res.status(409).json({ error: 'DUPLICATE_VIDEO' });
    }

    playlist.videos.unshift({ 
      videoId, 
      title, 
      thumbnail, 
      duration: duration || '', 
      channelTitle: channelTitle || '',
      addedAt: new Date()
    });
    const now = new Date();
    playlist.updatedAt = now;
    playlist.lastVideoAddedAt = now;
    await playlist.save();
    res.json({ success: true, playlist });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add video to playlist' });
  }
});

// Remove a video from a playlist
router.delete('/:playlistId/videos/:videoEntryId', requireAuth, async (req, res) => {
  try {
    const playlist = await Playlist.findOne({ 
      _id: req.params.playlistId, 
      userId: req.userId 
    });
    
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    playlist.videos = playlist.videos.filter(v => v._id.toString() !== req.params.videoEntryId);
    await playlist.save();
    res.json({ success: true, playlist });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove video from playlist' });
  }
});

// Rename a playlist
router.put('/:playlistId', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'New name required' });

    const playlist = await Playlist.findOne({ 
      _id: req.params.playlistId, 
      userId: req.userId 
    });
    
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const existingPlaylists = await Playlist.find({ userId: req.userId });
    const duplicate = findDuplicatePlaylist(existingPlaylists, name, req.params.playlistId);
    if (duplicate) {
      return res.status(409).json({
        error: 'DUPLICATE_NAME',
        message: 'A playlist with this name already exists',
        playlist: duplicate
      });
    }

    playlist.name = getPlaylistVisibleName(name);
    playlist.displayKey = getPlaylistVisibleNameKey(name);
    playlist.updatedAt = new Date();
    await playlist.save();
    res.json({ success: true, playlist });
  } catch (error) {
    res.status(500).json({ error: 'Failed to rename playlist' });
  }
});

// Move video between playlists
router.post('/:playlistId/move', requireAuth, async (req, res) => {
  try {
    const { videoEntryId, targetPlaylistId } = req.body;
    if (!videoEntryId || !targetPlaylistId) {
      return res.status(400).json({ error: 'Video entry ID and target playlist ID required' });
    }

    if (String(req.params.playlistId) === String(targetPlaylistId)) {
      return res.status(400).json({ error: 'Source and target playlist are the same' });
    }

    const sourcePlaylist = await Playlist.findOne({ 
      _id: req.params.playlistId, 
      userId: req.userId 
    });
    
    const targetPlaylist = await Playlist.findOne({ 
      _id: targetPlaylistId, 
      userId: req.userId 
    });

    if (!sourcePlaylist || !targetPlaylist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const video = sourcePlaylist.videos.id(videoEntryId);
    if (!video) {
      return res.status(404).json({ error: 'Video not found in source playlist' });
    }

    const alreadyInTarget = targetPlaylist.videos.some(
      (v) => v.videoId && video.videoId && v.videoId === video.videoId
    );

    sourcePlaylist.videos = sourcePlaylist.videos.filter(
      (v) => v._id.toString() !== String(videoEntryId)
    );

    if (!alreadyInTarget) {
      // Clone plain fields so mongoose subdoc moves cleanly
      targetPlaylist.videos.unshift({
        videoId: video.videoId,
        title: video.title,
        thumbnail: video.thumbnail,
        duration: video.duration,
        channelTitle: video.channelTitle,
        addedAt: new Date(),
      });
      targetPlaylist.lastVideoAddedAt = new Date();
    }

    sourcePlaylist.updatedAt = new Date();
    targetPlaylist.updatedAt = new Date();
    await Promise.all([sourcePlaylist.save(), targetPlaylist.save()]);
    res.json({
      success: true,
      alreadyInTarget,
      sourcePlaylist,
      targetPlaylist,
    });
  } catch (error) {
    console.error('Error moving playlist video:', error);
    res.status(500).json({ error: 'Failed to move video' });
  }
});

// Delete a playlist
router.delete('/:playlistId', requireAuth, async (req, res) => {
  try {
    const playlist = await Playlist.findOneAndDelete({ _id: req.params.playlistId, userId: req.userId });
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

// Rename a video title in a playlist
router.put('/:playlistId/videos/:videoEntryId/title', requireAuth, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'New title required' });

    const playlist = await Playlist.findOne({ _id: req.params.playlistId, userId: req.userId });
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const video = playlist.videos.id(req.params.videoEntryId);
    if (!video) {
      return res.status(404).json({ error: 'Video not found in playlist' });
    }

    video.title = title;
    await playlist.save();
    res.json({ success: true, playlist });
  } catch (error) {
    res.status(500).json({ error: 'Failed to rename video title' });
  }
});

// Bulk update video metadata in a playlist
router.post('/:playlistId/videos/bulk-update', requireAuth, async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Updates array is required' });
    }

    const playlist = await Playlist.findOne({ 
      _id: req.params.playlistId, 
      userId: req.userId 
    });
    
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    let updatedCount = 0;
    
    // Process each update
    for (const update of updates) {
      const { videoId, duration, channelTitle } = update;
      if (!videoId) continue;
      
      // Find the video in the playlist
      const videoIndex = playlist.videos.findIndex(v => v.videoId === videoId);
      if (videoIndex !== -1) {
        // Update the video metadata
        if (duration) playlist.videos[videoIndex].duration = duration;
        if (channelTitle) playlist.videos[videoIndex].channelTitle = channelTitle;
        updatedCount++;
      }
    }
    
    if (updatedCount > 0) {
      await playlist.save();
    }
    
    console.log(`✅ [BULK-UPDATE] Updated ${updatedCount} videos in playlist: ${playlist.name}`);
    
    res.json({ 
      success: true, 
      message: `Updated ${updatedCount} videos`,
      updatedCount 
    });
    
  } catch (error) {
    console.error('❌ [BULK-UPDATE] Error:', error);
    res.status(500).json({ error: 'Failed to update videos' });
  }
});

module.exports = router; 