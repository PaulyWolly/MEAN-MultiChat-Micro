/**
 * Joke API endpoints — peeled from monolith server.js.
 * Mounted at /api/jokes
 */
const express = require('express');
const mongoose = require('mongoose');
const Joke = require('../models/Joke');

const router = express.Router();

/** Existing single-user Multichat docs live under these keys. */
const LEGACY_DATA_KEY = 'global-persistent-storage-001-v1';
const LEGACY_USER_ALIASES = ['default-user', LEGACY_DATA_KEY];

// GET /list-jokes
router.get('/list-jokes', async (req, res) => {
  try {
    const showAll = req.query.showAll === 'true';
    const { sessionId } = req.query;
    const collection = mongoose.connection.collection('my_jokes');

    console.log('Jokes API Request:', { showAll, sessionId });

    let jokes;
    let totalJokes;

    if (showAll) {
      jokes = await collection.find({}).sort({ dateCreated: -1 }).toArray();
      totalJokes = jokes.length;
    } else {
      const userIds =
        sessionId === LEGACY_DATA_KEY ? LEGACY_USER_ALIASES : [sessionId];
      const query = { userId: { $in: userIds } };
      jokes = await collection.find(query).sort({ dateCreated: -1 }).toArray();
      totalJokes = jokes.length;
    }

    res.json({
      success: true,
      jokes,
      totalJokes,
    });
  } catch (error) {
    console.error('Error fetching jokes:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred while fetching jokes.',
    });
  }
});

// POST /save-joke
router.post('/save-joke', async (req, res) => {
  try {
    const { title, content, userId } = req.body;
    console.log('Save joke request:', { title, userId });

    const joke = new Joke({
      title,
      content,
      userId,
      dateCreated: new Date(),
    });

    await joke.save();
    res.json({ success: true, joke });
  } catch (error) {
    console.error('Error saving joke:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /get-joke/:title
router.get('/get-joke/:title', async (req, res) => {
  try {
    const { title } = req.params;
    const { sessionId } = req.query;
    console.log('Get joke request:', { title, sessionId });

    const normalize = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/gi, '').trim();
    const normalizedTitle = normalize(title);
    const jokes = await Joke.find({ userId: sessionId });
    const found = jokes.find((j) => normalize(j.title) === normalizedTitle);

    res.json({ success: true, joke: found || null });
  } catch (error) {
    console.error('Error retrieving joke:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /delete-joke/:id
router.delete('/delete-joke/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log('Delete joke request:', { id });

    await Joke.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting joke:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /update-joke/:id — id is the original title
router.put('/update-joke/:id', async (req, res) => {
  try {
    const originalTitle = decodeURIComponent(req.params.id);
    const { title: newTitle, content, userId } = req.body;

    const collection = mongoose.connection.collection('my_jokes');

    const updateFields = {};
    if (content !== undefined) updateFields.content = content;
    if (newTitle !== undefined) updateFields.title = newTitle;

    const existingJoke = await collection.findOne({
      title: new RegExp(
        `^${originalTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        'i',
      ),
      userId,
    });

    if (!existingJoke) {
      return res.status(404).json({
        success: false,
        error: 'Joke not found',
      });
    }

    const result = await collection.findOneAndUpdate(
      { _id: existingJoke._id },
      { $set: updateFields },
      { returnDocument: 'after' },
    );

    if (!result.value) {
      return res.status(404).json({
        success: false,
        error: 'Failed to update joke',
      });
    }

    return res.json({
      success: true,
      joke: result.value,
    });
  } catch (error) {
    console.error('Error updating joke:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// GET /search-jokes
router.get('/search-jokes', async (req, res) => {
  try {
    const { term } = req.query;
    const jokes = await Joke.find({
      $or: [
        { title: new RegExp(term, 'i') },
        { content: new RegExp(term, 'i') },
      ],
    });
    res.json({ success: true, jokes });
  } catch (error) {
    console.error('Error searching jokes:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /migrate
router.post('/migrate', async (req, res) => {
  try {
    const { sessionId, oldFormat } = req.body;
    const collection = mongoose.connection.collection('my_jokes');

    const jokes = await collection
      .find({
        userId: sessionId,
        format: oldFormat,
      })
      .toArray();

    const updates = jokes.map((joke) =>
      collection.updateOne(
        { _id: joke._id },
        {
          $set: {
            format: 'v20.0.1',
            updatedAt: new Date(),
          },
        },
      ),
    );

    await Promise.all(updates);

    res.json({
      success: true,
      migrated: updates.length,
    });
  } catch (error) {
    console.error('Error migrating jokes:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
