/**
 * Recipe parse endpoint — peeled from monolith server.js.
 * Mounted at /api/recipe (POST /)
 */
const express = require('express');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { text } = req.body || {};

    if (text == null || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({
        success: false,
        error: 'text is required',
      });
    }

    const recipeMatch = text.match(/^(.*?)(?=\s*Here is)/is);

    if (recipeMatch) {
      let recipeName = recipeMatch[1].trim();
      recipeName = recipeName
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase());

      console.log('Recipe name extracted and formatted:', recipeName);

      return res.json({
        success: true,
        recipe: {
          name: recipeName,
          text,
        },
      });
    }

    const altMatch = text.match(/^([A-Z][A-Z\s]+)/);
    if (altMatch) {
      const recipeName = altMatch[1].replace(/\s+/g, ' ').trim();
      console.log('Recipe name extracted (alt):', recipeName);
      return res.json({
        success: true,
        recipe: {
          name: recipeName,
          text,
        },
      });
    }

    console.error('Failed to match recipe pattern in text:', text.substring(0, 100));
    return res.status(400).json({
      success: false,
      error: 'Could not parse recipe format',
    });
  } catch (error) {
    console.error('Error in recipe endpoint:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to process recipe',
    });
  }
});

module.exports = router;
