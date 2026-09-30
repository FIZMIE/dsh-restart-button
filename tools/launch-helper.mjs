/**
 * Restart the running DeepSeek Harness from outside the plugin.
 *
 * This is the agent-facing path: the plugin's own route delegates to the same
 * helper, but a host-side JavaScript change only takes effect in a new process,
 * so an out-of-process launcher is needed to bootstrap a fixed helper.
 *
 * The helper MUST be spawned detached. Observed failure: a helper started
 * without detaching died together with the application it had just killed, so
 * nothing relaunched the app.
 *
 * usage: node tools/launch-helper.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? 'http://127.0.0.1:19387';

// 1. Refresh both helper artefacts from the on-disk host half.
execFileSync(process.execPath, [join(here, 'extract-helper.mjs')], { stdio: 'inherit' });

// 2. Ask the live host who it is and what to run.
const status = await (await fetch(`${base}/dsh-restart-button/status`, { cache: 'no-store' })).json();
if (!status.canRestart) throw new Error(`restart unavailable: ${status.reason}`);

const stateDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.dsh-restart-button');
const helper = join(stateDir, 'restart-helper.cjs');
const activate = join(stateDir, 'activate-window.ps1');
const launcher = join(stateDir, 'launch-worker.vbs');
const logFile = join(stateDir, 'restart.log');

const args = [
  helper,
  status.appExe,
  String(status.port ?? 0),
  logFile,
  String(status.ppid ?? 0), // Electron main: owns the window
  String(status.pid), // the DSH host child: this process's own process
  status.appImage,
  '', // confirmMs: default
  activate,
  launcher, // the primary delegates the relaunch to an out-of-tree WMI worker
];
console.log('helper args:', JSON.stringify(args));

// 3. Spawn detached so it outlives the application it is about to kill. Even if
// this primary does die with the app, it has already handed the relaunch to the
// worker, which is not a descendant of the app.
const child = spawn(status.nodeExe, args, { detached: true, stdio: 'ignore', windowsHide: true });
child.unref();
console.log(`helper spawned detached: pid ${child.pid}`);
console.log(`it will kill main=${status.ppid} host=${status.pid}; the out-of-tree worker relaunches and foregrounds.`);
console.log(`log: ${logFile}`);
