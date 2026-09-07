/**
 * Kill leftover MEAN-MultiChat Angular / Express / gateway processes
 * and free ports 4800–4809 / 4810–4812 / 4200 before starting a fresh stack.
 */
import { execSync, spawnSync } from "node:child_process"
import process from "node:process"

const PORTS = [4800, 4801, 4802, 4803, 4804, 4805, 4806, 4807, 4808, 4809, 4810, 4811, 4812, 4200]
const MARKERS = [
  "MEAN-MultiChat",
  "backend\\\\server",
  "backend/server",
  "backend\\\\services\\\\gateway",
  "backend/services/gateway",
  "backend\\\\services\\\\auth-service",
  "backend/services/auth-service",
  "backend\\\\services\\\\rag-service",
  "backend/services/rag-service",
  "backend\\\\services\\\\images-service",
  "backend/services/images-service",
  "backend\\\\services\\\\chat-service",
  "backend/services/chat-service",
  "backend\\\\services\\\\media-service",
  "backend/services/media-service",
  "backend\\\\services\\\\speech-service",
  "backend/services/speech-service",
  "backend\\\\services\\\\jokes-service",
  "backend/services/jokes-service",
  "backend\\\\services\\\\recipes-service",
  "backend/services/recipes-service",
  "backend\\\\services\\\\profile-service",
  "backend/services/profile-service",
  "backend\\\\services\\\\usage-service",
  "backend/services/usage-service",
  "backend\\\\services\\\\platform-service",
  "backend/services/platform-service",
]

function log(msg) {
  console.log(`[kill-dev] ${msg}`)
}

function killPorts() {
  try {
    execSync(`npx --yes kill-port ${PORTS.join(" ")}`, {
      stdio: "inherit",
      shell: true,
    })
  } catch {
    log("kill-port finished (some ports may already have been free)")
  }
}

function killMatchingWindowsProcesses() {
  const ps = `
$markers = @(${MARKERS.map((m) => `'${m.replace(/'/g, "''")}'`).join(",")})
$procs = Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue
foreach ($p in $procs) {
  $cmd = $p.CommandLine
  if (-not $cmd) { continue }
  $hit = $false
  foreach ($m in $markers) {
    if ($cmd -like ("*" + $m + "*")) { $hit = $true; break }
  }
  if (-not $hit) {
    if ($cmd -match 'nodemon|concurrently|ng serve|server\\.js') {
      if ($cmd -match 'MEAN-MultiChat|backend\\\\server|backend/server|backend\\\\services|backend/services') { $hit = $true }
    }
  }
  if (-not $hit) { continue }
  if ($p.ProcessId -eq $PID) { continue }
  Write-Host ("[kill-dev] Stopping PID " + $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
`
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
    { encoding: "utf8", windowsHide: true }
  )
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

log("Clearing MEAN-MultiChat dev processes and ports…")
if (process.platform === "win32") {
  killMatchingWindowsProcesses()
}
killPorts()
log("Ready to start")
