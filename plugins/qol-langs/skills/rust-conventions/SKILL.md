---
name: rust-conventions
description: Use when writing Rust in this workspace. Workspace-specific style and gotchas (error handling, filesystem, process management, cross-platform code layout) — NOT a generic Rust reference. For canonical Rust/library docs, use context7 instead. Plugin-specific and qol-tray-specific Rust gotchas live in their own skills (`qol-plugin-*`, `qol-tray-core`, `qol-tray-rust`, `qol-arch-code`, `qol-arch-cross-platform`).
---

# Rust Guidelines

## Cross-Platform Support

Platform-specific code should be isolated in dedicated modules:
- Use `platform/` subdirectories for OS-specific implementations
- Keep main modules free of `#[cfg(target_os)]` conditionals when possible
- All platform differences should be handled at the platform abstraction layer
- For structured cross-platform compartmentalization (strategy pattern, platform/ subfolders), see the `qol-arch-code` skill
- For symbol/import hygiene that prevents `dead_code`/`unused_imports` errors on the OSes you don't usually develop on, see `qol-arch-cross-platform`
- For the CI/release workflow contract that catches what the static checks miss, see `qol-arch-cicd`

## Error Handling

- `.expect()` is acceptable for compile-time invariants (embedded assets)
- `.expect()` is NOT acceptable for runtime operations (file paths, config dirs)
- Return `Option` or `Result` and let callers decide how to handle
- Log errors at the point of failure, not just at the top level

## Process Management

When stopping child processes:
1. Send SIGTERM first (Unix) to allow graceful cleanup
2. Wait with timeout (2s is reasonable)
3. Only SIGKILL if process doesn't respond
4. Use `qol-process` for PID liveness, termination escalation, waiting, and
   child reaping; do not duplicate `kill`, `waitpid`, or Windows process-handle
   plumbing in apps and plugins
5. Keep raw platform signaling capability-local only when a non-standard signal
   such as SIGINT is part of the external program's protocol

## Filesystem

- Use `std::path::PathBuf` and `Path` for all file operations
- Use `std::env::temp_dir()` instead of hardcoded `/tmp`
- `Path::exists()` returns `false` for broken symlinks - use `symlink_metadata().is_ok()` to detect symlink existence
- Use `qol-fs::{atomic_write, atomic_write_durable}` for regular file-content
  replacement; never hand-roll sibling temp writes and renames. Binary swaps,
  directory promotion, and no-clobber creation stay capability-local.

## Performance

- Use appropriate data structures (HashMap for lookups, Vec for iteration)
- Avoid cloning large data structures unnecessarily
- Profile before optimizing
- Batch operations when possible (e.g., 16ms intervals for 60fps)

### Idle cost is a feature

Background threads, supervisors, watchers, listeners (anything always-on) MUST be free-when-idle, not just cheap. Wakeups themselves cost the user.

- **Event-driven by default.** Block on the source: `crossbeam_channel::select!`, `tokio::select!`, `Receiver::recv()`, `inotify`, `signalfd`. Never `try_recv` + `thread::sleep`.
- **No `try_recv + sleep_ms` loops.** That is not polling, that is busy-waiting with rest periods. Replace with a blocking `select!` over every channel the loop cares about.
- **No `tokio::time::interval` in always-on paths** unless you need genuinely periodic side effects (heartbeat, render tick) AND the work is gated to "needed right now". An interval that fires while the UI is closed is a bug.
- **Sub-50ms `Duration::from_millis(...)` in always-on background code is a code smell.** Justify it or remove it. Render-rate intervals (16ms / 60fps) are fine *only* while the surface is visible.
- **One blocking primitive per loop.** If you have N event sources, use `select!` over all N. Do not poll one and block on another.

## Code Layout & Style

- **Early Returns:** Prioritize early-return and flatten `if` statements as much as possible to avoid nested conditionals.
- **Shallow Scopes:** Ideally, max depth for any function should be one scope.
- **Delegation:** When logic gets complex or deeply nested, delegate internal blocks to separate, well-named functions rather than nesting `if`/`match`/`for` blocks. This ensures each function does exactly one logical thing and remains easy to reason about.
