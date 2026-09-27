---
name: qol-tray-task-runner-ide-checkout
description: Use when working on the qol-tray IDE Checkout local HTTP API, browser-extension compatibility, request validation, and checkout execution flow.
---

# IDE Checkout API contract

Locate the plugin through the manifest declaring `id = "qol-ide-checkout"`. All paths below are relative to that plugin. [The plugin skill](../qol-plugin-ide-checkout/SKILL.md) owns daemon, config, packaging, and platform boundaries.

## Source-owned HTTP contract

`src/daemon/server.rs` owns exact methods/routes, `CheckoutBody`, response/error serialization, and caller checks. Read that router and its tests before changing a consumer. Its health, shutdown, and checkout handlers are exposed through `GET /health`, `POST /shutdown`, and `POST /checkout`; do not infer a generic task-discovery or arbitrary-execution API.

Read request requirements and defaults from `CheckoutBody` and `handle_checkout`, and addressing from the manifest/daemon boundary. Avoid copying payload examples or error inventories into this skill.

## Checkout workflow

The caller supplies the local project and requested branch, optionally selecting a configured app. The checkout module validates inputs, resolves the repository remote, derives a destination under the configured temporary root, then clones or refreshes the existing checkout. The router opens that checkout in the selected app and returns its result. App-launch failure after checkout preserves the checkout path in the error response; consumers must distinguish that partial outcome from checkout failure.

`src/daemon/checkout.rs` owns validation, Git subprocess arguments, timeouts, destination construction, and app launch. `src/daemon/config.rs` and `qol-config.toml` own configured apps and temporary-root settings.

## Security considerations

Preserve the loopback bind/inherited-listener boundary and the router's POST mutation checks for Host, Origin, and fetch metadata. Exact accepted values and missing-header behavior come from `is_blocked_mutation`, its helper predicates, and their tests; these checks do not establish authenticated network-peer access.

Responses do not advertise wildcard CORS. Preserve the parser's body/time limits, checkout path and branch validation, and explicit process arguments rather than shell interpolation. Do not claim a configurable origin allowlist, arbitrary script execution, or universal path confinement beyond the source's actual checks.

## Consumer changes

Change the router/model and consuming extension together. Cover accepted and rejected callers, malformed requests, checkout failures, successful checkout/open, and partial app-launch failure with the owning tests. Inspect the actual extension checkout before claiming consumer compatibility.
