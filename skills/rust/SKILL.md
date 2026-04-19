---
name: rust
description: Use when writing Rust in this workspace — error handling, filesystem, process management, cross-platform code layout, and style. Plugin-specific and qol-tray-specific Rust gotchas live in their own skills (`qol-plugin-*`, `qol-tray`, `qol-architecture`).
---

# Rust Guidelines

## Cross-Platform Support

Platform-specific code should be isolated in dedicated modules:
- Use `platform/` subdirectories for OS-specific implementations
- Keep main modules free of `#[cfg(target_os)]` conditionals when possible
- All platform differences should be handled at the platform abstraction layer
- For structured cross-platform compartmentalization, see the `qol-architecture` skill

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

## Code Layout & Style

- **Early Returns:** Prioritize early-return and flatten `if` statements as much as possible to avoid nested conditionals.
- **Shallow Scopes:** Ideally, max depth for any function should be one scope.
- **Delegation:** When logic gets complex or deeply nested, delegate internal blocks to separate, well-named functions rather than nesting `if`/`match`/`for` blocks. This ensures each function does exactly one logical thing and remains easy to reason about.
