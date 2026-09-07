/**
 * Optional: keep the gateway alive (`npm run start:respawn`).
 * Default `npm start` is plain `node server.js` so kill:dev / port reclaim stays simple.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(dir, 'server.js');

let startedAt = 0;

function run() {
  startedAt = Date.now();
  const child = spawn(process.execPath, [entry], {
    cwd: dir,
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    const livedMs = Date.now() - startedAt;
    // Boot/bind failures (EADDRINUSE) exit quickly — don't spin forever.
    if (livedMs < 3000) {
      console.error(
        `[gateway] process exited during startup (${reason}, lived ${livedMs}ms); not restarting`,
      );
      process.exit(typeof code === 'number' ? code || 1 : 1);
      return;
    }
    console.error(`[gateway] process exited (${reason}); restarting in 1s…`);
    setTimeout(run, 1000);
  });
}

run();
