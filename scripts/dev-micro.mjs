/**
 * Start microservices stack with gateway on an inherited TTY so the
 * ♡ heartbeat can overwrite one line with `\r`. Other services run via Nx.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: isWin,
      ...opts,
    })
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} killed by ${signal}`))
      else if (code) reject(new Error(`${command} exited ${code}`))
      else resolve()
    })
    child.on('error', reject)
  })
}

function spawnInherit(command, args, opts = {}) {
  return spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
    ...opts,
  })
}

await run('node', ['scripts/kill-dev.mjs'])

const children = []

const gateway = spawnInherit('node', ['server.js'], {
  cwd: path.join(root, 'backend/services/gateway'),
  env: { ...process.env, PORT: '4800' },
})
children.push(gateway)

const nxProjects = [
  'auth',
  'rag',
  'images',
  'chat',
  'media',
  'speech',
  'jokes',
  'recipes',
  'profile',
  'usage',
  'platform',
  'monolith',
  'mean-multichat-micro',
].join(',')

const nx = spawnInherit(
  'npx',
  [
    'nx',
    'run-many',
    '-t',
    'serve',
    '--parallel=100',
    '--output-style=stream',
    `--projects=${nxProjects}`,
  ],
  { env: { ...process.env, NX_TUI: 'false' } },
)
children.push(nx)

function shutdown(signal) {
  for (const child of children) {
    if (!child.killed) child.kill(signal)
  }
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

const codes = await Promise.all(
  children.map(
    (child) =>
      new Promise((resolve) => {
        child.on('exit', (code) => resolve(code ?? 1))
      }),
  ),
)

shutdown('SIGTERM')
process.exit(codes.find((c) => c !== 0) ?? 0)
