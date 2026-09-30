/**
 * dsh-restart-button — host half.
 *
 * Provides a one-click restart of the whole DeepSeek Harness Desktop application.
 *
 * Process model (verified against the packaged Desktop build):
 *   the Electron main process (lib/main.js) owns the window, the tray and the
 *   app lifecycle; the DSH host — this plugin included — runs in a *child*
 *   process spawned with ELECTRON_RUN_AS_NODE=1 and an IPC channel. A plugin
 *   therefore cannot call Electron's `app.relaunch()`, and the child→parent IPC
 *   protocol only carries a `ready` event, so there is no restart message to
 *   send either.
 *
 * What this does instead: it writes a small helper to $DSH_HOME and starts it
 * under the bundled standalone `node.exe`, deliberately NOT under
 * "DeepSeek Harness.exe". The helper waits for our HTTP response to flush,
 * kills every "DeepSeek Harness.exe" image (which is the whole app, and is a
 * different image name from the helper, so the helper survives), waits for the
 * image and the web port to disappear, and relaunches the application.
 *
 * Routes (all under /dsh-restart-button):
 *   GET  /status   → process identity, resolved executables, availability
 *   GET  /health   → boot id + uptime, used by the browser half to notice the
 *                    new process after a restart
 *   POST /restart  → schedule the restart; answers 202 before the app dies
 *
 * `POST /restart` is accepted only from a loopback peer, and only when the
 * request either carries a same-origin/renderer `Origin` or the local token
 * written to $DSH_HOME/.dsh-restart-button/token. That token is the
 * agent-facing path: any local process that can read it may restart the app.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

/** Cordis plugin name. */
export const name = 'dsh-restart-button';

/** Services required before the routes can mount. */
export const inject = ['webServer'];

const NS = 'dsh-restart-button';
/** Fallback image name, used only when the application executable cannot be resolved. */
const APP_IMAGE_FALLBACK = 'DeepSeek Harness.exe';

/** Identifier for this host process, stable for its lifetime. */
const bootId = `${process.pid}-${Math.round(Date.now() - process.uptime() * 1000)}`;

// ── filesystem layout ────────────────────────────────────────────────────────

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

function stateDir() {
  return join(dshHome(), '.dsh-restart-button');
}

function tokenFile() {
  return join(stateDir(), 'token');
}

function helperFile() {
  return join(stateDir(), 'restart-helper.cjs');
}

function helperLog() {
  return join(stateDir(), 'restart.log');
}

function activateFile() {
  return join(stateDir(), 'activate-window.ps1');
}

function launcherFile() {
  return join(stateDir(), 'launch-worker.vbs');
}

/** Read the local restart token, creating it on first use. */
function readToken() {
  try {
    const existing = readFileSync(tokenFile(), 'utf8').trim();
    if (existing !== '') return existing;
  } catch {
    /* create below */
  }
  const token = randomBytes(24).toString('hex');
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(tokenFile(), `${token}\n`, 'utf8');
  } catch {
    /* a read-only home still leaves the token usable for this process */
  }
  return token;
}

// ── executable discovery ─────────────────────────────────────────────────────

/**
 * Walk up from a path until the directory that owns `resources/app.asar`.
 * @param start - a path inside the installation.
 * @returns the installation root, or undefined.
 */
function findInstallRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'resources', 'app.asar')) || existsSync(join(dir, 'resources', 'app'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Whether a path is a Node runtime rather than the Electron shell. */
function isNodeRuntime(p) {
  return /^node(\.exe)?$/i.test(basename(p));
}

/**
 * Resolve the application executable that starts the Desktop app.
 * @returns an absolute path, or undefined when it cannot be determined.
 */
function resolveAppExe() {
  const execPath = process.execPath;
  if (!isNodeRuntime(execPath)) return execPath;

  const candidates = [];
  const declared = process.env.DSH_DESKTOP_NODE_EXECUTABLE;
  if (declared !== undefined && declared !== '' && !isNodeRuntime(declared)) candidates.push(declared);

  const root = findInstallRoot(dirname(execPath));
  if (root !== undefined) {
    try {
      const installed = readdirSync(root)
        .filter((entry) => entry.toLowerCase().endsWith('.exe'))
        .filter((entry) => !/^uninstall/i.test(entry) && !/^elevate/i.test(entry))
        .map((entry) => join(root, entry))
        .sort((a, b) => statSync(b).size - statSync(a).size);
      if (installed[0] !== undefined) candidates.push(installed[0]);
    } catch {
      /* fall through to the remaining candidates */
    }
  }
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Resolve a standalone Node runtime to host the restart helper.
 *
 * The helper must not run under the application image: it kills every process
 * with that image name, and would otherwise kill itself mid-restart.
 * @returns an absolute path or the bare name for a PATH lookup.
 */
function resolveNodeExe() {
  const execPath = process.execPath;
  if (isNodeRuntime(execPath)) return execPath;

  const candidates = [];
  const root = findInstallRoot(dirname(execPath));
  if (root !== undefined) {
    candidates.push(join(root, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'));
  }
  // The launcher passes a bin directory as a positional argument and prepends
  // it to PATH for the host child.
  for (const arg of process.argv.slice(2)) {
    if (typeof arg === 'string' && arg !== '' && !arg.startsWith('-')) candidates.push(join(arg, 'node.exe'));
  }
  candidates.push(join(dirname(execPath), 'node.exe'));
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir !== '') candidates.push(join(dir, 'node.exe'));
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  return found;
}

/** The web port this host listens on, when it can be determined. */function webPort(webServer) {
  const fromService = webServer?.port;
  if (typeof fromService === 'number' && fromService > 0) return fromService;
  const url = process.env.DSH_WEB_URL;
  if (typeof url === 'string' && url !== '') {
    try {
      const parsed = new URL(url);
      if (parsed.port !== '') return Number(parsed.port);
    } catch {
      /* ignore a malformed URL */
    }
  }
  return undefined;
}

// ── the detached restart helper ──────────────────────────────────────────────

const HELPER_SOURCE = String.raw`'use strict';
// dsh-restart-button helper. CJS, run by the bundled standalone node.exe.
//
// Two modes, both the same file:
//   primary - spawned by the plugin inside the application's process tree. It
//             first hands the relaunch to a copy of itself created through the
//             WMI provider (see below), then terminates the application.
//   worker  - that WMI-created copy. It lives OUTSIDE the application's process
//             tree, so the kill cannot take it down, and it is the process that
//             actually relaunches the app and foregrounds its window.
//
// Why the WMI detour: measured on this machine, a helper spawned by the plugin
// dies together with the application it has just killed (restart.log stops right
// after the kill line), so nothing relaunched the app. A process created by
// Invoke-CimMethod Win32_Process.Create is parented to WmiPrvSE.exe and runs in
// the interactive session, so it survives - and a GUI app started from it is
// still visible.
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');

const appExe = process.argv[2];
const port = process.argv[3] ? Number(process.argv[3]) : 0;
const logFile = process.argv[4];
const mainPid = process.argv[5] ? Number(process.argv[5]) : 0;
const hostPid = process.argv[6] ? Number(process.argv[6]) : 0;
const imageName = process.argv[7] || 'DeepSeek Harness.exe';
const confirmMs = process.argv[8] ? Number(process.argv[8]) : 20000;
const activateFile = process.argv[9] || '';
const launcherFile = process.argv[10] || '';
const mode = process.argv[11] === 'worker' ? 'worker' : 'primary';
const nodeExe = process.execPath;
const helperFile = __filename;

/** Hard cap on relaunch spawns: whatever happens, the helper stops after this many. */
const MAX_ATTEMPTS = 5;

function log(message) {
  try { fs.appendFileSync(logFile, new Date().toISOString() + ' [' + mode + '] ' + message + '\n'); } catch {}
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the port can still be bound, i.e. nobody is listening on it. */
function portIsFree() {
  if (!port) return Promise.resolve(true);
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/** Terminate one process by pid. On Windows this is an unconditional terminate. */
function killPid(pid) {
  if (!pid) return false;
  try { process.kill(pid); return true; } catch { return false; }
}

/**
 * Create a process through the WMI provider.
 *
 * The created process is parented to WmiPrvSE.exe and runs in the caller's
 * interactive session, so it is neither a descendant of this application nor
 * invisible. That is what makes the relaunch survive the kill.
 * @param commandLine - full command line for the new process.
 * @returns the created pid, or 0 on failure.
 */
function wmiCreate(commandLine) {
  const escaped = String(commandLine).replace(/'/g, "''");
  const script = '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = \'' + escaped + '\' }; Write-Output ("$($r.ReturnValue)|$($r.ProcessId)")';
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });
    const parts = String(out).trim().split('|');
    const returnValue = Number(parts[0]);
    const pid = Number(parts[1]) || 0;
    log('wmi create -> ReturnValue=' + returnValue + ' pid=' + pid);
    return returnValue === 0 ? pid : 0;
  } catch (error) {
    log('wmi create failed: ' + String(error && error.message));
    return 0;
  }
}

/**
 * Hand the relaunch to a copy of this helper created outside the application's
 * process tree, via wscript.exe (a GUI-subsystem host, so no console appears).
 * @returns the worker pid, or 0 when it could not be created.
 */
function scheduleWorker() {
  if (!launcherFile || !fs.existsSync(launcherFile)) {
    log('no launcher available; the application will be relaunched by this helper instead');
    return 0;
  }
  const quote = (value) => '"' + String(value) + '"';
  // Resolved from the environment rather than hardcoded, so this is not tied to
  // a Windows install on C:.
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const wscript = systemRoot + '\\System32\\wscript.exe';
  const workerArgs = [
    nodeExe,
    helperFile,
    appExe,
    String(port),
    logFile,
    String(mainPid),
    String(hostPid),
    imageName,
    String(confirmMs),
    activateFile,
    launcherFile,
    'worker',
  ];
  const commandLine = [quote(wscript), quote(launcherFile)].concat(workerArgs.map(quote)).join(' ');
  log('scheduling the out-of-tree worker');
  return wmiCreate(commandLine);
}

/**
 * Bring the relaunched application's window to the foreground.
 *
 * The application is started by this background helper, so Windows does not hand
 * it the foreground on its own and it can end up behind whatever was in front.
 * A short-lived hidden PowerShell does the Win32 activation and reports the
 * outcome into the same log.
 * @param pid - the application's main process id.
 */
function bringToFront(pid) {
  if (!pid || !activateFile) return Promise.resolve();
  return new Promise((resolve) => {
    let child;
    try {
      // NOT detached, unlike every other spawn here. Measured on this machine:
      // a detached powershell.exe never runs at all (DETACHED_PROCESS leaves a
      // console program that needs a console with none, and it exits at once),
      // while detached:false + windowsHide runs it with no visible window.
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', activateFile, String(pid), logFile],
        { detached: false, stdio: 'ignore', windowsHide: true },
      );
    } catch (error) {
      log('activation request failed: ' + String(error && error.message));
      resolve();
      return;
    }
    log('activation requested for pid ' + pid);

    // This helper must outlive the activation child: also measured, a
    // non-detached child is killed when its parent exits first. So wait for it
    // (bounded, in case the window never appears).
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      log('activation timed out; stopped waiting');
      resolve();
    }, 60000);
    const finish = (note) => {
      clearTimeout(timer);
      log(note);
      resolve();
    };
    child.on('exit', () => finish('activation finished'));
    child.on('error', (error) => finish('activation spawn error: ' + String(error && error.message)));
  });
}

async function main() {
  log('helper start pid=' + process.pid + ' appExe=' + appExe + ' port=' + port + ' main=' + mainPid + ' host=' + hostPid);
  log('inherited ELECTRON_RUN_AS_NODE=' + JSON.stringify(process.env.ELECTRON_RUN_AS_NODE) + ' (must not reach the app)');

  // The DSH host child runs as Electron in Node mode, so its environment carries
  // ELECTRON_RUN_AS_NODE=1 (set by the Desktop launcher's desktopNodeEnvironment).
  // Handing that to the application executable makes it boot as a bare Node
  // process: it allocates a console window, the GUI never appears, and the
  // restart looks like it killed the app without bringing it back.
  const appEnv = Object.assign({}, process.env);
  delete appEnv.ELECTRON_RUN_AS_NODE;

  // Primary mode does the killing; the worker does the relaunching. The worker is
  // created BEFORE the kill, through the WMI provider, so it is outside the tree
  // that is about to be torn down.
  let workerPid = 0;
  if (mode === 'primary') {
    workerPid = scheduleWorker();
    if (workerPid) {
      log('relaunch delegated to out-of-tree worker pid ' + workerPid);
      await sleep(800); // give wscript time to start node before the tree dies
    } else {
      log('no worker; this helper will relaunch the application itself');
    }
  }

  // Let the 202 response reach the browser before the app goes away.
  await sleep(400);

  if (mode === 'primary') {
    // Kill by pid rather than shelling out to taskkill: no extra console process,
    // and no process-startup latency on the critical path. The Electron main goes
    // first so its window disappears at once instead of flashing a backend-failure
    // state; the host child (this helper's own parent) follows.
    const killedMain = killPid(mainPid);
    const killedHost = killPid(hostPid);
    log('kill main(' + mainPid + ')=' + killedMain + ' host(' + hostPid + ')=' + killedHost);
    if (!killedMain && !killedHost) {
      try {
        execFileSync('taskkill', ['/F', '/IM', imageName], { stdio: 'ignore', windowsHide: true });
        log('fallback taskkill /F /IM "' + imageName + '" issued');
      } catch (error) {
        log('fallback taskkill failed: ' + String(error && error.message));
      }
    }
    if (workerPid) {
      // The worker owns the relaunch from here. This helper may well be killed
      // with the application any moment now; if it survives, it records the
      // timing for the log.
      if (!port) return;
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        await sleep(250);
        if (!(await portIsFree())) {
          log('app is listening on ' + port + ' again; worker handled the relaunch');
          return;
        }
      }
      log('the port never came back while this helper was alive');
      return;
    }
  }

  // The port being free is the only reliable "the old app is really gone".
  let freedAfter;
  for (let i = 0; i < 100; i += 1) {
    if (await portIsFree()) { freedAfter = i * 100; break; }
    await sleep(100);
  }
  log('port ' + port + ' free after ' + (freedAfter === undefined ? '>10000' : String(freedAfter)) + 'ms');

  // Relaunch, then confirm against the web port answering again: "the image
  // exists" said nothing about the window, which is what the user waits for.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    let appPid = 0;
    try {
      // No windowsHide here on purpose. libuv implements it as
      // STARTF_USESHOWWINDOW + wShowWindow = SW_HIDE, and a GUI application's
      // first ShowWindow obeys that: the window exists but stays hidden until the
      // user clicks its taskbar button. The application is a GUI-subsystem binary,
      // so there is no console to hide in the first place. Detaching keeps it
      // independent of this helper.
      const child = spawn(appExe, [], { detached: true, stdio: 'ignore', env: appEnv });
      child.unref();
      appPid = child.pid;
      log('relaunch attempt ' + attempt + '/' + MAX_ATTEMPTS + ': spawned pid=' + appPid);
    } catch (error) {
      log('relaunch attempt ' + attempt + '/' + MAX_ATTEMPTS + ' failed to spawn: ' + String(error && error.message));
      await sleep(1000);
      continue;
    }
    if (!port) { log('no port to confirm against; not retrying'); return; }
    let up = false;
    const deadline = Date.now() + confirmMs;
    while (Date.now() < deadline) {
      await sleep(250);
      if (!(await portIsFree())) { up = true; break; }
    }
    if (up) {
      log('app is listening on ' + port + ' after ' + (Date.now() - started) + 'ms (attempt ' + attempt + ')');
      await bringToFront(appPid);
      return;
    }
    log('relaunch attempt ' + attempt + '/' + MAX_ATTEMPTS + ' was not confirmed within ' + confirmMs + 'ms');
    await sleep(1000);
  }
  log('giving up after ' + MAX_ATTEMPTS + ' relaunch attempts without confirmation');
}

main().catch((error) => log('helper error: ' + String(error)));
`;

/**
 * PowerShell that asks Win32 to foreground the relaunched application's window.
 *
 * Kept in its own file rather than an inline -Command so the quoting stays
 * readable and the script can be run by hand while debugging.
 */
const ACTIVATE_SOURCE = String.raw`# dsh-restart-button: bring the relaunched application's window to the front.
# The application is started by a background helper, so Windows does not hand it
# the foreground by itself; this script asks for it explicitly.
param([int]$TargetPid, [string]$LogFile)
$ErrorActionPreference = 'SilentlyContinue'

function Note([string]$m) {
  try {
    Add-Content -LiteralPath $LogFile -Value ((Get-Date).ToUniversalTime().ToString('o') + ' [activate] ' + $m)
  } catch { }
}

if (-not ('Dsh.Win' -as [type])) {
  Add-Type -Namespace Dsh -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool a);'
}

$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) {
    [Dsh.Win]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
    if ([Dsh.Win]::SetForegroundWindow($p.MainWindowHandle)) {
      Note 'brought the window to the foreground'
    } else {
      [Dsh.Win]::SwitchToThisWindow($p.MainWindowHandle, $true)
      Note 'SetForegroundWindow was refused; used SwitchToThisWindow'
    }
    exit 0
  }
  Start-Sleep -Milliseconds 400
}
Note 'no main window appeared within 120s'
`;

/**
 * VBScript launcher for the out-of-tree worker.
 *
 * It is started by the WMI provider, so it - and the helper it starts - are not
 * descendants of the DSH application. wscript.exe is a GUI-subsystem host, so no
 * console window appears anywhere in this chain, and `Run ... 0` keeps the
 * helper itself windowless too. It waits for the helper (bWaitOnReturn = True):
 * measured on this machine, a child started by a parent that exits immediately
 * does not survive.
 */
const LAUNCHER_SOURCE = String.raw`' dsh-restart-button launcher.
' Started through the WMI provider (parent: WmiPrvSE.exe), so this script and the
' helper it starts are NOT descendants of the DSH application - which is what
' lets them survive the restart they are performing.
' args: nodeExe, helperFile, then every argument the helper itself takes
Option Explicit
Dim sh, cmd, i
Set sh = CreateObject("WScript.Shell")
cmd = """" & WScript.Arguments(0) & """"
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next
' 0 = hidden window, True = wait for the helper (so it outlives this script)
sh.Run cmd, 0, True
`;

function ensureHelper() {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(helperFile(), HELPER_SOURCE, 'utf8');
  writeFileSync(activateFile(), ACTIVATE_SOURCE, 'utf8');
  writeFileSync(launcherFile(), LAUNCHER_SOURCE, 'utf8');
}

/**
 * Spawn the detached helper that restarts the application.
 * @param webServer - the host web server, for the listening port.
 * @returns the helper PID, or undefined when no Node runtime was found.
 */
function spawnHelper(webServer) {
  const appExe = resolveAppExe();
  const nodeExe = resolveNodeExe();
  if (appExe === undefined || nodeExe === undefined) return undefined;
  ensureHelper();
  const port = webPort(webServer);
  const child = spawn(
    nodeExe,
    [
      helperFile(),
      appExe,
      port === undefined ? '0' : String(port),
      helperLog(),
      // The Electron main owns the window and the child lifecycle; the host child
      // is this very process. The helper terminates both by pid.
      String(process.ppid ?? 0),
      String(process.pid),
      // Derived from the resolved executable so this is not tied to one product
      // name: the helper only needs it for the taskkill fallback.
      basename(appExe),
      '', // confirmMs: default
      activateFile(),
      launcherFile(),
    ],
    {
      // Detached is REQUIRED, not cosmetic. Observed in restart.log: a helper
      // started without it died together with the application it had just killed,
      // so nothing ever relaunched the app. Detached helpers survive the kill and
      // finish the job.
      //
      // It does not cost a console window: DETACHED_PROCESS means the helper
      // inherits no console and is given none, and with stdio 'ignore' it never
      // writes anywhere that would allocate one. (The stray console box seen
      // earlier came from the application itself booting as a Node process, which
      // is fixed in the helper by stripping ELECTRON_RUN_AS_NODE.)
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
  return child.pid;
}

// ── request helpers ─────────────────────────────────────────────────────────

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(text);
}

function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Whether the request came from the app's own renderer. */
function trustedOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined || origin === '') return true; // a plain local POST; not reachable from a web page
  if (origin.startsWith('dsh-app://')) return true;
  try {
    const parsed = new URL(origin);
    const host = request.headers.host;
    return parsed.host === host && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function tokenMatches(request, token) {
  const supplied = request.headers['x-dsh-restart-token'];
  return typeof supplied === 'string' && supplied !== '' && supplied === token;
}

// ── plugin body ──────────────────────────────────────────────────────────────

/**
 * Mount the restart routes once the host web server is available.
 * @param ctx - cordis host context.
 */
export function apply(ctx) {
  const token = readToken();
  ctx.inject(['webServer'], (host) => {
    const webServer = host.webServer ?? ctx.get('webServer');
    if (webServer === undefined) return;

    const status = () => {
      const appExe = resolveAppExe();
      const nodeExe = resolveNodeExe();
      return {
        ok: true,
        bootId,
        pid: process.pid,
        ppid: process.ppid,
        uptimeMs: Math.round(process.uptime() * 1000),
        execPath: process.execPath,
        argv: process.argv,
        nodeVersion: process.version,
        platform: process.platform,
        appExe: appExe ?? null,
        nodeExe: nodeExe ?? null,
        appImage: appExe === undefined ? APP_IMAGE_FALLBACK : basename(appExe),
        port: webPort(webServer) ?? null,
        canRestart: appExe !== undefined && nodeExe !== undefined,
        reason: appExe === undefined ? 'application executable not found' : nodeExe === undefined ? 'standalone node runtime not found' : null,
        tokenFile: tokenFile(),
        helperLog: helperLog(),
        dshHome: dshHome(),
        // Diagnostic for the restart bug: the host child runs as Electron in Node
        // mode, so this is "1" here. The helper must strip it before spawning the
        // application, or the app boots as a console Node process instead of a GUI.
        electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
        maxRelaunchAttempts: 5,
      };
    };

    const disposers = [
      webServer.register({
        kind: 'exact',
        path: `/${NS}/status`,
        handler: (request, response) => {
          if (request.method !== 'GET') {
            sendJson(response, 405, { error: 'method not allowed' });
            return;
          }
          sendJson(response, 200, status());
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `/${NS}/health`,
        handler: (request, response) => {
          if (request.method !== 'GET') {
            sendJson(response, 405, { error: 'method not allowed' });
            return;
          }
          sendJson(response, 200, { ok: true, bootId, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) });
        },
      }),
      webServer.register({
        kind: 'exact',
        path: `/${NS}/restart`,
        handler: (request, response) => {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: 'method not allowed' });
            return;
          }
          if (!isLoopback(request)) {
            sendJson(response, 403, { error: 'loopback only' });
            return;
          }
          if (!trustedOrigin(request) && !tokenMatches(request, token)) {
            sendJson(response, 403, { error: 'untrusted origin' });
            return;
          }
          const node = resolveNodeExe();
          const app = resolveAppExe();
          if (node === undefined || app === undefined) {
            sendJson(response, 503, {
              error: 'restart unavailable',
              reason: app === undefined ? 'application executable not found' : 'standalone node runtime not found',
            });
            return;
          }
          let helperPid;
          try {
            helperPid = spawnHelper(webServer);
          } catch (error) {
            sendJson(response, 500, { error: String(error?.message ?? error) });
            return;
          }
          sendJson(response, 202, { ok: true, scheduled: true, bootId, helperPid: helperPid ?? null, at: Date.now() });
        },
      }),
    ];

    host.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* the route table may already be gone */
        }
      }
    }, `${NS}: restart routes`);
  });
}
