import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [
  path.join(root, 'backend', 'server'),
  ...readdirSync(path.join(root, 'backend', 'services'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, 'backend', 'services', entry.name)),
];

for (const dir of dirs) {
  console.log(`\n=== npm install (${path.relative(root, dir)}) ===`);
  const result = spawnSync('npm', ['install'], {
    cwd: dir,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
