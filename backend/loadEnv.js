'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Shared env loader for the monolith and every microservice.
 *
 *   1. `backend/server/.env`     (shared secrets)
 *   2. service-local `.env`      (PORT / CORS overrides; wins when present)
 *
 * @param {typeof import('dotenv')} dotenv
 * @param {string} serviceDir  `__dirname` of the calling process
 */
function loadEnv(dotenv, serviceDir) {
  const serverEnv = path.join(__dirname, 'server', '.env');
  const localEnv = path.join(serviceDir, '.env');

  const seen = new Set();
  const load = (filePath, options) => {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved) || !fs.existsSync(resolved)) return;
    seen.add(resolved);
    dotenv.config({ path: resolved, ...options });
  };

  // PORT in backend/server/.env is for the monolith. Do not let it steal
  // a microservice's default (gateway would bind 4810 and crash).
  const portBeforeShared = process.env.PORT;
  load(serverEnv);
  if (portBeforeShared === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = portBeforeShared;
  }

  load(localEnv, { override: true });
}

module.exports = loadEnv;
