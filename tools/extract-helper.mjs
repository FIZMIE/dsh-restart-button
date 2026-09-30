/**
 * Regenerate the helper artefacts from the host half.
 *
 * The plugin writes both files itself on every restart, from the templates
 * embedded in lib/index.js. This tool does the same from outside the host
 * process, which is what lets a fixed helper restart an app whose in-memory host
 * code is still the previous generation.
 *
 * usage: node tools/extract-helper.mjs [pluginDir] [stateDir]
 */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(process.argv[2] ?? join(here, '..'));
const stateDir = resolve(process.argv[3] ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.dsh-restart-button'));

const source = fs.readFileSync(join(pluginDir, 'lib', 'index.js'), 'utf8');
fs.mkdirSync(stateDir, { recursive: true });

function extract(name) {
  const match = new RegExp(`const ${name} = String\\.raw\`([\\s\\S]*?)\`;\\n`).exec(source);
  if (match === null) throw new Error(`${name} not found in lib/index.js`);
  if (match[1].includes('${')) throw new Error(`${name} template must not interpolate`);
  if (match[1].includes('`')) throw new Error(`${name} template must not contain a backtick`);
  return match[1];
}

const helper = extract('HELPER_SOURCE');
const activate = extract('ACTIVATE_SOURCE');
const launcher = extract('LAUNCHER_SOURCE');

fs.writeFileSync(join(stateDir, 'restart-helper.cjs'), helper, 'utf8');
fs.writeFileSync(join(stateDir, 'activate-window.ps1'), activate, 'utf8');
fs.writeFileSync(join(stateDir, 'launch-worker.vbs'), launcher, 'utf8');

const guards = [
  ['strips ELECTRON_RUN_AS_NODE', helper.includes('delete appEnv.ELECTRON_RUN_AS_NODE')],
  ['relaunch cap of 5', helper.includes('MAX_ATTEMPTS = 5')],
  ['kills by pid', helper.includes('process.kill(pid)')],
  ['delegates the relaunch via WMI', helper.includes('wmiCreate(commandLine)')],
  ['has a worker mode', helper.includes("=== 'worker'")],
  ['does not hide the app window', !/spawn\(appExe, \[\], \{[^}]*windowsHide/.test(helper)],
  ['keeps the app env cleaned', /spawn\(appExe, \[\], \{ detached: true, stdio: 'ignore', env: appEnv \}\)/.test(helper)],
  ['activation is not detached (detached powershell never runs)', /powershell\.exe[\s\S]{0,400}?detached: false/.test(helper)],
  ['launcher waits for the helper', /sh\.Run cmd, 0, True/.test(launcher)],
  ['never shells out to tasklist', !helper.includes('tasklist')],
];
console.log(`wrote restart-helper.cjs (${helper.length}), activate-window.ps1 (${activate.length}), launch-worker.vbs (${launcher.length}) to ${stateDir}`);
for (const [label, ok] of guards) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) throw new Error(`helper guard failed: ${label}`);
}
