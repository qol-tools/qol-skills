---
name: rust
description: Use when working on Rust plugins in this workspace, including cross-platform structure, error handling, and process management patterns.
---

# Rust Plugin Guidelines

## Cross-Platform Support

Platform-specific code should be isolated in dedicated modules:
- Use `platform/` subdirectories for OS-specific implementations
- Keep main modules free of `#[cfg(target_os)]` conditionals when possible
- All platform differences should be handled at the platform abstraction layer

### Platform-Specific Patterns

**Linux:**
- GTK event loops typically run in separate threads
- Use X11 bindings for low-level system interactions

**macOS:**
- UI frameworks (NSApplication, tray icons) MUST be created on the main thread
- `NSApplication.run()` blocks the main thread until quit
- Run async runtimes (Tokio) on background threads
- Use `objc2` crate for Cocoa bindings
- Use CoreGraphics APIs directly for performance-critical operations
- Never shell-split paths for `Command` args — pass `Path` directly to `Command::new("open").arg(path)` to avoid crashes on paths with spaces (e.g., `.app` bundles)
- `cx.hide()` hides the entire NSApplication — use `window.remove_window()` for popup-style windows that need to reappear later

**Windows:**
- Use Win32 APIs for system interactions
- Blocking patterns often use Condvar or WaitForSingleObject

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
4. Use `libc::kill()` directly

## Filesystem

- Use `std::path::PathBuf` and `Path` for all file operations
- Use `std::env::temp_dir()` instead of hardcoded `/tmp`
- `Path::exists()` returns `false` for broken symlinks - use `symlink_metadata().is_ok()` to detect symlink existence

## Performance

- Use appropriate data structures (HashMap for lookups, Vec for iteration)
- Avoid cloning large data structures unnecessarily
- Profile before optimizing
- Batch operations when possible (e.g., 16ms intervals for 60fps)

## Local CI Verification

Before claiming a Rust repo is fixed, and again before push, run the full local verification suite:

```bash
cargo fmt -- --check
cargo clippy --all-targets --all-features --keep-going -- -D warnings
cargo test --all-features
```

Critical rules:
- Prefer the repo's own validation entry points first when they exist. If a Makefile or project script defines the normal build/test path, run that before falling back to raw cargo commands.
- `--keep-going` is required so ALL errors across all targets (lib, bin, tests, examples) are reported in one pass. Without it, cargo stops at the first failing target and you'll discover errors one at a time.
- `--all-targets` is required — clippy errors in test files won't show up without it.
- `-D warnings` is required — this is what CI uses. Warnings are errors.
- `cargo check` or `cargo test` alone is NOT sufficient. Clippy is what CI enforces.
- If the repo is not feature-heavy and a project-local skill defines a required stack, run that exact stack during iteration too, not only before push.
- If local `rustc --version` doesn't match CI (CI uses latest stable via `dtolnay/rust-toolchain@stable`), update local Rust first (`rustup update stable`) or flag the version mismatch. Different clippy versions catch different lints.
- Fix ALL reported errors before committing. Never fix-commit-push iteratively.
- If the user reports a build failure after you claimed success, rerun the user's exact failing command first and treat that command as the source of truth.

## Code Layout & Style

- **Early Returns:** Prioritize early-return and flatten `if` statements as much as possible to avoid nested conditionals.
- **Shallow Scopes:** Ideally, max depth for any function should be one scope.
- **Delegation:** When logic gets complex or deeply nested, delegate internal blocks to separate, well-named functions rather than nesting `if`/`match`/`for` blocks. This ensures each function does exactly one logical thing and remains easy to reason about.
