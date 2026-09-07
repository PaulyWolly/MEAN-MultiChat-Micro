/**
 * /api/auth/* — peeled from monolith server.js
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getAuth0Issuer, resolveAuth0UserFromToken } = require('../middleware/auth0');
const { getJwtSecret } = require('../middleware/auth');
const {
  SALT_ROUNDS,
  getSuperAdminPassword,
  generateToken,
  publicUserPayload,
  ensureUserDataKey,
} = require('../lib/authHelpers');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
    }

    // --- SUPERADMIN MAGIC CODE LOGIN ---
    const superAdminWithCode = await User.findOne({ role: 'superadmin', oneTimeCode: password });
    if (superAdminWithCode) {
      superAdminWithCode.oneTimeCode = null;
      superAdminWithCode.updated = new Date();
      await superAdminWithCode.save();

      await ensureUserDataKey(superAdminWithCode);
      const token = generateToken(superAdminWithCode);
      console.log(`[AUTH] SuperAdmin magic code login: ${email}`);
      return res.json({
        success: true,
        token,
        user: publicUserPayload(superAdminWithCode),
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated',
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    await ensureUserDataKey(user);

    user.authProvider = null;
    user.updated = new Date();
    await user.save();

    const token = generateToken(user, { authMethod: 'password' });

    console.log(`[AUTH] User logged in: ${user.email} (${user.role}) dataKey=${user.dataKey}`);

    res.json({
      success: true,
      token,
      user: publicUserPayload(user, { authMethod: 'password' }),
    });
  } catch (error) {
    console.error('[AUTH] Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

router.post('/create-admin', async (req, res) => {
  try {
    const { email, password, secret } = req.body;
    const CLI_SECRET = process.env.CLI_SECRET || 'cli-secret-2025';

    if (secret !== CLI_SECRET) {
      return res.status(401).json({
        success: false,
        message: 'Invalid secret key',
      });
    }

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      existingUser.role = 'admin';
      existingUser.isActive = true;
      existingUser.updated = new Date();

      const isPasswordValid = await bcrypt.compare(password, existingUser.password);
      if (!isPasswordValid) {
        existingUser.password = await bcrypt.hash(password, SALT_ROUNDS);
      }

      await existingUser.save();
      console.log(`[AUTH] Existing user updated to admin: ${email}`);

      return res.json({
        success: true,
        message: 'User role updated to admin successfully',
        user: {
          id: existingUser._id,
          email: existingUser.email,
          role: existingUser.role,
        },
      });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const adminUser = new User({
      email: email.toLowerCase(),
      password: hashedPassword,
      role: 'admin',
      isActive: true,
      created: new Date(),
      updated: new Date(),
    });

    await adminUser.save();
    console.log(`[AUTH] New admin user created: ${email}`);

    res.json({
      success: true,
      message: 'Admin user created successfully',
      user: {
        id: adminUser._id,
        email: adminUser.email,
        role: adminUser.role,
      },
    });
  } catch (error) {
    console.error('[AUTH] Create admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;

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
      role: 'user',
    });

    await user.save();
    await ensureUserDataKey(user);

    const token = generateToken(user);

    console.log(`[AUTH] New user registered: ${user.email} dataKey=${user.dataKey}`);

    res.status(201).json({
      success: true,
      token,
      user: publicUserPayload(user),
    });
  } catch (error) {
    console.error('[AUTH] Register error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

router.post('/superadmin-login', async (req, res) => {
  try {
    const { password, oneTimeCode } = req.body;
    const SUPERADMIN_PASSWORD = getSuperAdminPassword();

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required',
      });
    }

    if (password !== SUPERADMIN_PASSWORD) {
      return res.status(401).json({
        success: false,
        message: 'Invalid SuperAdmin credentials',
      });
    }

    if (oneTimeCode) {
      const userWithCode = await User.findOne({
        oneTimeCode,
        role: 'superadmin',
      });

      if (!userWithCode) {
        return res.status(401).json({
          success: false,
          message: 'Invalid one-time code',
        });
      }

      userWithCode.oneTimeCode = null;
      userWithCode.updated = new Date();
      await userWithCode.save();

      const token = generateToken(userWithCode);

      console.log(`[AUTH] SuperAdmin logged in with code: ${userWithCode.email}`);

      return res.json({
        success: true,
        token,
        user: {
          id: userWithCode._id,
          email: userWithCode.email,
          role: userWithCode.role,
        },
      });
    }

    let superAdmin = await User.findOne({ role: 'superadmin' });

    if (!superAdmin) {
      const hashedPassword = await bcrypt.hash(SUPERADMIN_PASSWORD, SALT_ROUNDS);
      superAdmin = new User({
        email: 'superadmin@system.local',
        password: hashedPassword,
        role: 'superadmin',
      });
      await superAdmin.save();
    }

    const token = generateToken(superAdmin);

    console.log(`[AUTH] SuperAdmin logged in: ${superAdmin.email}`);

    res.json({
      success: true,
      token,
      user: {
        id: superAdmin._id,
        email: superAdmin.email,
        role: superAdmin.role,
      },
    });
  } catch (error) {
    console.error('[AUTH] SuperAdmin login error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

router.post('/verify', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token is required',
      });
    }

    const decoded = jwt.verify(token, getJwtSecret());

    const user = await User.findById(decoded.userId);
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token',
      });
    }

    await ensureUserDataKey(user);

    const freshToken = generateToken(user, {
      authMethod: decoded.authMethod || user.authProvider || 'password',
    });

    res.json({
      success: true,
      token: freshToken,
      user: publicUserPayload(user, {
        authMethod: decoded.authMethod || user.authProvider || 'password',
      }),
    });
  } catch (error) {
    console.error('[AUTH] Token verification error:', error);
    res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
    });
  }
});

/**
 * Auth0 / Google social login.
 * Body: { accessToken?, idToken? } and/or Authorization: Bearer <Auth0 access_token>
 */
router.post('/oauth', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const accessToken = (req.body?.accessToken || bearer || '').trim();
    const idToken = (req.body?.idToken || '').trim();
    const token = accessToken || idToken;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Auth0 access token or id token is required',
      });
    }

    if (!getAuth0Issuer()) {
      return res.status(503).json({
        success: false,
        message: 'Auth0 is not configured on the server (AUTH0_ISSUER_BASE_URL)',
      });
    }

    let auth0User = await resolveAuth0UserFromToken(accessToken || token);
    if (!auth0User && idToken && idToken !== accessToken) {
      auth0User = await resolveAuth0UserFromToken(idToken);
    }

    if (!auth0User?.email) {
      return res.status(401).json({
        success: false,
        message: 'Could not resolve email from Auth0 token',
      });
    }

    const authProvider = String(auth0User.sub || '').startsWith('google-oauth2')
      ? 'google'
      : 'auth0';

    let user = await User.findOne({ email: auth0User.email });
    if (!user) {
      const randomPassword = `auth0-user-${Date.now()}-${Math.random()}`;
      const hashedPassword = await bcrypt.hash(randomPassword, SALT_ROUNDS);
      user = new User({
        email: auth0User.email,
        password: hashedPassword,
        role: 'user',
        auth0Id: auth0User.sub || null,
        authProvider,
      });
      await user.save();
      console.log(`[AUTH] OAuth new user: ${user.email} (${authProvider})`);
    } else {
      if (!user.isActive) {
        return res.status(401).json({
          success: false,
          message: 'Account is deactivated',
        });
      }
      user.auth0Id = auth0User.sub || user.auth0Id;
      user.authProvider = authProvider;
      user.updated = new Date();
      await user.save();
      console.log(`[AUTH] OAuth login: ${user.email} (${authProvider})`);
    }

    await ensureUserDataKey(user);
    const appToken = generateToken(user, { authMethod: authProvider });

    res.json({
      success: true,
      token: appToken,
      user: publicUserPayload(user, { authMethod: authProvider }),
    });
  } catch (error) {
    console.error('[AUTH] OAuth error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

router.post('/generate-superadmin-code', async (req, res) => {
  try {
    const { secret } = req.body;
    const CLI_SECRET = process.env.CLI_SECRET || 'cli-secret-2025';
    const SUPERADMIN_PASSWORD = getSuperAdminPassword();

    if (secret !== CLI_SECRET) {
      return res.status(401).json({
        success: false,
        message: 'Invalid CLI secret',
      });
    }

    const oneTimeCode =
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15);

    let superAdmin = await User.findOne({ role: 'superadmin' });

    if (!superAdmin) {
      const hashedPassword = await bcrypt.hash(SUPERADMIN_PASSWORD, SALT_ROUNDS);
      superAdmin = new User({
        email: 'superadmin@system.local',
        password: hashedPassword,
        role: 'superadmin',
      });
    }

    superAdmin.oneTimeCode = oneTimeCode;
    superAdmin.updated = new Date();
    await superAdmin.save();

    console.log(`[AUTH] SuperAdmin one-time code generated: ${oneTimeCode}`);

    res.json({
      success: true,
      oneTimeCode,
      expiresIn: '10 minutes (use immediately)',
    });
  } catch (error) {
    console.error('[AUTH] Generate code error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

/** Generate JWT token for playlist authentication */
router.post('/token', (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    const token = jwt.sign({ userId }, getJwtSecret(), { expiresIn: '24h' });
    res.json({ token });
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

module.exports = router;
