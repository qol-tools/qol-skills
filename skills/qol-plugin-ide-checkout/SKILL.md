---
name: qol-plugin-ide-checkout
description: Use when working on the qol-tray ide-checkout (Task Runner) plugin itself. Covers the Rust binary that supervises the Python HTTP daemon, status notifications, configurable apps/scripts, and the Task Runner browser-extension API. For the API contract specification (endpoints, schemas), use the qol-tray-task-runner-ide-checkout skill instead.
---

# qol-plugin-ide-checkout

The "Task Runner" plugin for qol-tray. Despite the directory name, the plugin name is **Task Runner** and the runtime binary is **`task-runner`**. It's a thin Rust supervisor that launches `server.py` (a Python HTTP daemon) and reports status. The Python side does the heavy lifting: serves the [Task Runner API](#api-contract) for browser extensions to clone branches, open IDEs, and run scripts.

**Skill split:**
- This skill: the **plugin itself** (binary, daemon supervision, status, config).
- `qol-tray-task-runner-ide-checkout`: the **API contract** consumed by browser extensions (endpoints, schemas, error codes).

## Plugin Contract

`plugin.toml`:

- `runtime.command = "task-runner"` (not `ide-checkout` and not `plugin-ide-checkout`)
- `runtime.actions = { status = ["status"] }`
- `[daemon] enabled = true`, `command = "task-runner"` (no args → daemon mode)
- Menu: `Status` (action `run`) — pops a desktop notification with daemon health
- Platforms: `macos`, `linux`
- Binary download repo: `qol-tools/plugin-ide-checkout`, pattern `task-runner-{os}-{arch}`

`qol-config.toml`:

- `[section.general]`: `temp_dir` (default `/tmp/task-runner`) — where `git-checkout` clones land
- `[section.apps]`: `apps` is an `object_map` keyed by app ID with `name` (string) and `paths` (string_array). Each entry tells the daemon how to launch a configured IDE.
- `[section.scripts]`: `scripts` is an `object_map` keyed by script ID with `command`, `cwd`, `timeout`. Defines named scripts the daemon may execute.

The Python daemon's `DEFAULT_CONFIG` in `server.py` matches this shape with idea, vscode, cursor, zed prebaked.

## Architecture

```
plugin-ide-checkout/
  Cargo.toml         # Rust binary "task-runner"
  src/main.rs        # 172 lines — supervisor + status notifier
  server.py          # Python HTTP daemon, port 42710
  plugin.toml        # qol-tray manifest
  qol-config.toml    # config contract
  README.md
```

**`src/main.rs`** dispatches:
- `task-runner` (no args) or `task-runner daemon`: locate `server.py` next to the binary, exec `python3 server.py` (Unix uses `exec`, Windows uses `Command::status`).
- `task-runner status`: probe `127.0.0.1:42710/health` (300ms timeout), fire a desktop notification via osascript (macOS) → notify-send (Linux) → stdout.

**`server.py`** is a single-file `http.server` + `socketserver` daemon implementing the Task Runner API. Built-in actions:
- `git-checkout` — clone/checkout a branch into `tempDir`
- `open-app` — spawn a configured app with a path
- `run-script` — execute a named script with `{{params.x}}` expansion and env var injection
- Plus action chaining via `POST /execute { chain: [...] }`

See the `qol-tray-task-runner-ide-checkout` skill for the full API contract (endpoints, request/response shapes, error codes, security model).

## Common Tasks

**Add a new built-in action**: Edit `BUILTIN_ACTIONS` in `server.py` and add a handler in the request dispatcher. The action becomes available via `POST /execute` automatically.

**Add a configured app default**: Edit `DEFAULT_CONFIG['apps']` in `server.py`. The app appears in `GET /actions` under `open-app`'s available apps.

**Bump the daemon port**: change `PORT` in `server.py` AND the probe URL in `src/main.rs::daemon_is_running`. Browser-extension consumers also need updating.

**Change the temp dir default**: update `DEFAULT_TEMP_DIR` in `server.py` and `field.temp_dir.default` in `qol-config.toml`.

**Disable a default app/script**: there's no allowlist mechanism — every app in `DEFAULT_CONFIG` is available unless the user overrides their on-disk `config.json`.

## Gotchas

- **Two binaries, one repo**: the Rust `task-runner` is just a supervisor; the real work is in `server.py`. When debugging, check stdout/stderr of the Python daemon, not the Rust process — the Rust process `exec`s into Python on Unix and is gone.
- **`server.py` resolves relative to the binary**: `plugin_dir() = current_exe.parent`. If the user runs `task-runner` from another directory, it still finds `server.py` correctly. Don't accept overrides via env without thinking through symlinks.
- **CORS handling lives in Python**, not Rust. Currently allows localhost extensions only (per the API contract spec). If you tighten or loosen, update both the contract spec skill and the daemon code.
- **`git-checkout` requires git on PATH**. The plugin doesn't bundle it. Failures show up as `EXECUTION_FAILED` errors with stderr in the response.
- **Path traversal**: the API contract requires path validation but `server.py`'s implementation should be audited periodically. Browser extensions are partially trusted; the network surface is localhost-only but XSS in the extension would expose this API.
- **Python 3.6+** is required at runtime. macOS ships an old python; modern setups should have homebrew Python3 on PATH.
- **Notification fallback chain**: osascript → notify-send → stdout. If neither tool exists, the user just gets a printed line — no error.

## Shared library usage

None. This plugin is intentionally independent — no `qol-plugin-api`, no `qol-config` Rust dep. Config schema is described in the contract TOML but the actual reading lives in Python.

## Build / Dev

- `cargo test` runs the standard `validate_plugin_contract` test.
- No Rust runtime deps in `Cargo.toml` (the supervisor uses only stdlib).
- For Python work: there's no requirements.txt either — `server.py` uses only the stdlib.
- Release flow: tag-driven via `qol-cicd`. The Rust binary ships per-OS; `server.py` ships next to it.
