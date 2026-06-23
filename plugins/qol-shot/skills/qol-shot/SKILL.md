---
name: qol-shot
description: Use when working on the qol-shot plugin (qol-tray screenshots and screen recording), including ffmpeg recording flow and Linux display capture behavior.
---

Screenshot and screen-recording plugin for qol-tray (Linux-focused). Binary-first runtime plugin.

## Contract

- Runtime command: `qol-shot`
- Runtime actions map:
  - `record -> ["record"]`
  - `screenshot -> ["screenshot"]`
  - `settings -> ["settings"]`
- Menu includes `toggle-config` checkbox (`audio-enable`) for config state; this does not require runtime action mapping.
- No shell runtime entrypoint.

## Contract Validation Test

Every plugin must include this test in `src/main.rs` to statically validate `plugin.toml` at `cargo test` time:

```rust
#[cfg(test)]
mod tests {
    use qol_tray::plugins::manifest::PluginManifest;

    #[test]
    fn validate_plugin_contract() {
        let manifest_str =
            std::fs::read_to_string("plugin.toml").expect("Failed to read plugin.toml");
        let manifest: PluginManifest =
            toml::from_str(&manifest_str).expect("Failed to parse plugin.toml");
        manifest.validate().expect("Manifest validation failed");
    }
}
```

Required `Cargo.toml` dev-dependencies:

```toml
[dev-dependencies]
qol-tray = { path = "../../qol-tray" }
toml = "0.9"
```

## Build and Dev Workflow

- No Makefile. qol-tray uses `cargo build` directly in dev mode.
- Do **not** leave a `qol-shot` binary in the plugin root directory - it will shadow `target/debug/qol-shot`.
- `qol-tray` resolves binaries in order: plugin root → `target/debug/` → `target/release/`.
- Run `cargo test` to validate the contract before linking or shipping.

## Runtime Dependencies

- `ffmpeg`
- `slop`
- `xrandr`
- `jq`

## Known Issues / TODO

1. **Wayland support** - Current tooling is X11-oriented (`xrandr`, `slop`).
   - Region selection alternative: `slurp`
   - Capture pipeline alternative: PipeWire via `xdg-desktop-portal`
   - Monitor enumeration alternatives: compositor protocols / desktop APIs

## Implementation Guidance

- Keep recording lifecycle idempotent (`record` toggles start/stop cleanly).
- Validate and sanitize any dynamic ffmpeg args before execution.
- Prefer clear failure modes for missing system tools and permission issues.
