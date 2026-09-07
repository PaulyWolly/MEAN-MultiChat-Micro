/**
 * /api/users — admin CRUD peeled from monolith server.js
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const {
  authenticateToken,
  requireAdmin,
  requireSuperAdmin,
} = require('../middleware/auth');
const { SALT_ROUNDS } = require('../lib/authHelpers');

const router = express.Router();

router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await User.find({}, { password: 0, oneTimeCode: 0 }).sort({ created: -1 });

    console.log(`[USERS] Retrieved ${users.length} users by ${req.user.email}`);

    res.json({
      success: true,
      users: users.map((user) => ({
        id: user._id,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        created: user.created,
        updated: user.updated,
      })),
    });
  } catch (error) {
    console.error('[USERS] Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { email, password, role = 'user' } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'User already exists',
      });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const user = new User({
      email: email.toLowerCase(),
      password: hashedPassword,
      role,
    });

    await user.save();

    console.log(`[USERS] New user created: ${user.email} (${user.role}) by ${req.user.email}`);

    res.status(201).json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        created: user.created,
        updated: user.updated,
      },
    });
  } catch (error) {
    console.error('[USERS] Create user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, role, isActive } = req.body;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (user.role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Cannot modify SuperAdmin user',
      });
    }

    if (email) user.email = email.toLowerCase();
    if (role !== undefined) user.role = role;
    if (isActive !== undefined) user.isActive = isActive;
    user.updated = new Date();

    await user.save();

    console.log(`[USERS] User updated: ${user.email} by ${req.user.email}`);

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        created: user.created,
        updated: user.updated,
      },
    });
  } catch (error) {
    console.error('[USERS] Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

router.delete('/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (user._id.toString() === req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Cannot delete your own account',
      });
    }

    if (user.role === 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Cannot delete SuperAdmin user',
      });
    }

    await User.findByIdAndDelete(id);

    console.log(`[USERS] User deleted: ${user.email} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'User deleted successfully',
    });
  } catch (error) {
    console.error('[USERS] Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

module.exports = router;
