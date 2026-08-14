---
name: qol-tray-dev-recompile
description: Use when you debug whether a qol-tray or plugin change reached the running process. Covers the canonical dev recompile/restart path, daemon teardown, plugin build provenance, and evidence needed before blaming stale code.
---

# qol-tray dev recompile

Use the host's canonical dev recompile action for an ordered host restart. Do not manually kill supervised plugin processes unless source inspection proves the host restart path cannot perform the required cleanup.

## Source ownership

- Find the frontend trigger and endpoint by searching for `recompile-self`; UI placement and labels are not stable documentation.
- Trace the endpoint through the recompile service, restart scheduler, plugin-manager shutdown, daemon tracker, and process replacement code.
- Read dev-link/build-state code to determine whether plugin binaries are rebuilt or merely restarted.
- Read the running build's response/logs to confirm which path actually executed.

Never rely on a copied function sequence or version label from this skill. The checked-out call graph and runtime trace own the behavior.

## Restart contract

A full host recompile is trustworthy only when the live path:

1. Produces or selects the intended host binary.
2. Stops short-lived plugin invocations and resident daemons through the supervisor.
3. Clears process-tracking state without deleting user configuration.
4. Replaces or restarts the host with the selected binary.
5. Lets the new host rediscover and supervise plugins from declared provenance.

If any step is absent or failed in runtime evidence, report that boundary rather than claiming a fresh slate.

## Plugin provenance matters

Restarting a daemon does not prove its executable was rebuilt. Before dismissing a stale-plugin hypothesis:

- Resolve the plugin slot as installed artifact or dev link from the live registry.
- Resolve the executable path chosen by the host.
- Check build planner/fingerprint state for a dev link.
- Build the plugin through the repository workflow when the selected executable predates source changes.
- Invoke the canonical host restart and confirm the new daemon's executable/provenance.

Avoid root-level copied binaries: resolver precedence may let them shadow workspace build output.

## Diagnostic decisions

**Host Rust/backend change:** rebuild/recompile the host, invoke the canonical restart, and verify the running executable identity.

**Plugin Rust change:** first ensure the selected plugin binary was rebuilt, then use the host restart to replace the supervised daemon.

**Frontend-only change:** use the frontend reload path when runtime logs show it handled the changed file; escalate to host restart only when the asset/build boundary requires it.

**Config/data change:** restart is not a substitute for proving which config scope/path the process loaded. Inspect the resolver and live diagnostics.

## Invariants

- Supervisor-owned processes are stopped through supervisor APIs, not broad `pkill` patterns.
- Restart cleanup preserves user config/profile data and external hardware state unless an explicit migration owns a change.
- Process freshness and binary freshness are separate claims with separate evidence.
- A same-PID exec or a new-PID spawn may both be valid; source/runtime evidence decides.
- Never state that all daemons or binaries are fresh merely because the user clicked a button.
