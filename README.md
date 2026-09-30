# dsh-restart-button

**One-click restart for the DeepSeek Harness desktop app** — a small refresh button
in the sidebar brand row, next to *DeepSeek Harness*, plus an HTTP route so an agent
(or a script) can restart the app itself.

[中文说明](README.zh.md)

![The restart button in the sidebar brand row](docs/restart-button.png)

*The restart button, immediately right of the wordmark.*

> ### ⚠️ One profile patch is required before the button appears
>
> The sidebar's brand row is a **`single` slot**, and `dsh-client-ui-slots` **throws** on
> a second registration for a `single` slot — so the shipped
> `@deepseek-ai/dsh-client-ui-brand-official` occupant has to step aside first.
>
> **Without it the plugin installs and its HTTP routes work, but the button never shows.**
>
> Append [`install/profile-patch.yml`](install/profile-patch.yml) to
> `$DSH_HOME/profiles/<profile>/cordis.patch.yml` — see [Install](#install).

---

## The problem

The packaged DeepSeek Harness desktop build has **no way to restart itself**:

| Where you would expect it | Reality |
|---|---|
| Tray context menu | Only *Open* and *Quit* |
| Application menu | `Restart App and Host` exists in the code, but it sits behind `const development = !app.isPackaged` — **development builds only** |
| Closing the window | Hides to the tray instead of quitting |

So every plugin install or configuration change that needs a fresh process means
*quit from the tray → find the icon → launch again*. This plugin adds the missing button.

## Requirements

| | |
|---|---|
| **OS** | Windows (the restart worker uses WMI, `wscript.exe` and Win32 foreground activation) |
| **Host** | DeepSeek Harness `0.2.0-rc.2` desktop build |
| **Profile patch** | **Required** — one `disabled: true` row, see step 1 below. Without it the plugin installs but the button never appears. |

## Install

### 1. Add the profile patch (required — do this first)

The sidebar's 7 render targets are almost all `single` slots, and the slot registry
**throws on a second registration** for a `single` slot
(`dsh-client-ui-slots`: `single slot "<name>" already has a registration`).
The brand row is owned by the shipped `@deepseek-ai/dsh-client-ui-brand-official`, so
that occupant has to step aside. The sidebar itself documents that as supported —
*"a deployment can replace the brand mark or name"* — and this plugin re-renders the
official wordmark, so the title looks unchanged.

Append to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: ui-brand-official
  name: "@deepseek-ai/dsh-client-ui-brand-official"
  disabled: true
```

The same lines, with the full rationale and the revert instructions, are available as
a copy-paste fragment: [`install/profile-patch.yml`](install/profile-patch.yml).

(`ui-brand-official` is the row id declared in `@deepseek-ai/dsh-web-app/cordis.patch.yml`.)

### 2. Add the bundle

A DSH plugin is an ordinary profile bundle, so either of these works:

```powershell
# from this repository
dsh plugin --profile desktop add git+https://github.com/FIZMIE/dsh-restart-button.git

# from a local checkout
dsh plugin --profile desktop add C:\path\to\dsh-restart-button
```

### 3. Refresh the page

Client changes are picked up by `dsh-client-modules` without a process restart, so a
browser refresh is enough. The button appears immediately right of the
*DeepSeek Harness* wordmark.

## What you get

- **Brand-row button** — a refresh glyph next to the wordmark. Click it, confirm, and
  the whole application restarts: the window disappears, comes back by itself, is
  brought to the foreground, and the page reloads.
- **Agent / script route** — `POST /dsh-restart-button/restart`, so an agent can
  restart the app without asking you to click anything.

## HTTP API

Everything is mounted on the host web server under `/dsh-restart-button`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/status` | Process identity, resolved executables, whether a restart is possible |
| `GET` | `/health` | `bootId` + uptime; the browser half polls it to notice the new process |
| `POST` | `/restart` | Schedules a restart and answers `202` before the app goes away |

`POST /restart` is accepted only from a loopback peer, and only when the request
carries either the app's own origin or the local token written to
`$DSH_HOME/.dsh-restart-button/token`. That token is the agent-facing path:

```powershell
$token = (Get-Content "$env:DSH_HOME\.dsh-restart-button\token" -Raw).Trim()
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:19387/dsh-restart-button/restart" `
  -Headers @{ 'X-DSH-Restart-Token' = $token }
```

## How it works

Restarting *this particular* application turns out to be surprisingly awkward, and the
code carries the reasons inline. The short version:

### The process model

The Desktop shell (`lib/main.js`) is the Electron main process. It spawns the DSH host —
**and therefore every plugin** — as a *child* process with
`ELECTRON_RUN_AS_NODE=1` and an IPC channel. A plugin can therefore not call
`app.relaunch()`, and the child→parent IPC protocol only carries a `ready` event, so
there is no "please restart" message to send either. The restart has to be performed by
a separate process.

### The out-of-tree worker

The first attempts spawned a helper that killed the app and then relaunched it. It
worked — right up until the app died: the helper died with it, and `restart.log` simply
stopped after the kill line. The reason is that the helper was still a descendant of the
application, and the application's process tree (job object) is torn down with it.

The fix is to **not be in that tree at all**. The helper's first action is to create a
copy of itself through the WMI provider:

```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '...' }
```

A process created that way is parented to `WmiPrvSE.exe` — a service process — and runs
in the interactive session (so a GUI application started from it is still visible). That
worker then waits for the old app to disappear, relaunches it, and foregrounds its
window. A `wscript.exe` + `.vbs` launcher starts the worker windowless, and waits for it
(`Run cmd, 0, True`) because — also measured — a non-detached child does not survive a
parent that exits immediately.

### Four Windows traps worth knowing

| Trap | Consequence | What this plugin does |
|---|---|---|
| The host child runs with `ELECTRON_RUN_AS_NODE=1` | Passed to `DeepSeek Harness.exe`, it boots as a bare Node process: a console window appears, the GUI never does, and the restart looks like it killed the app | Strip the variable for the child environment |
| `windowsHide` means `STARTF_USESHOWWINDOW` + `wShowWindow = SW_HIDE` | A GUI application's first `ShowWindow` obeys it, so the window exists but stays hidden until you click its taskbar button | Never pass `windowsHide` for the application spawn |
| `detached: true` and a detached `powershell.exe` | A detached console program that needs a console never runs at all | The helper (a Node process) may detach; the PowerShell activation step must not |
| "Is the process there?" is not "is the window up?" | The old helper reported success while the user was still staring at nothing | Confirm against the **web port answering again**, and log the real elapsed time |

It also kills by PID rather than shelling out to `taskkill` (one fewer console process,
and ~1.1 s less on the critical path), caps relaunch attempts at **5**, and logs
everything to `$DSH_HOME/.dsh-restart-button/restart.log`.

## What a restart actually looks like

One real restart on Windows, copied from `$DSH_HOME/.dsh-restart-button/restart.log`:

```
15:00:53.877 [primary] wmi create -> ReturnValue=0 pid=24172
15:00:53.877 [primary] relaunch delegated to out-of-tree worker pid 24172
15:00:53.919 [worker]  helper start pid=22748 port=19387 main=10192 host=20620
15:00:55.079 [primary] kill main(10192)=true host(20620)=true
15:00:55.141 [worker]  port 19387 free after 800ms
15:00:55.159 [worker]  relaunch attempt 1/5: spawned pid=23248
15:00:57.679 [worker]  app is listening on 19387 after 2535ms (attempt 1)
15:00:57.690 [worker]  activation requested for pid 23248
15:00:59.436 [activate] brought the window to the foreground
```

The whole design is visible in that ordering: the primary creates the out-of-tree worker
*before* killing anything, the worker is already running on the next line, and its
`port free` line comes **after** the application was terminated — which is precisely what
used to fail. From terminating the old process to the window being back in the
foreground takes about **5.5 seconds**, of which 2.5 seconds is DeepSeek Harness's own
startup.

## Requirements and limitations

- **Windows only.** The out-of-tree worker uses WMI, `wscript.exe` and Win32
  foreground activation.
- Built against DeepSeek Harness `0.2.0-rc.2`. It reads the launcher's
  `profileContext` service and mutates nothing but its own files, but it does depend on
  internals that can move.
- The restart is a **hard kill** (`TerminateProcess`), not a graceful shutdown:
  in-flight work is interrupted. DSH session data is append-only JSONL, so the risk to
  stored data is low, but it is not zero.
- The kill is by PID (the Electron main plus the DSH host child), so other processes are
  untouched.
- Relaunching is bounded: at most 5 attempts, then it gives up and says so in the log.
- Much of the remaining wait is DeepSeek Harness's own startup time, not this plugin's —
  the log records `app is listening on <port> after <n>ms` so you can tell them apart.

## Tools

Two small utilities, also used while developing this:

```powershell
# Regenerate the runtime artefacts from the templates inside lib/index.js and assert
# every invariant this plugin depends on (10 checks).
node tools/extract-helper.mjs

# Restart the running app from outside the plugin — the bootstrap path for when
# lib/index.js itself changed, since host-side JavaScript only takes effect in a
# new process.
node tools/launch-helper.mjs
```

`npm run check` runs the first one against a throwaway directory.

## License

MIT — see [LICENSE](LICENSE).
