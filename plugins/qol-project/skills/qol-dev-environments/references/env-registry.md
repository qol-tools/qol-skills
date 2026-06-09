# Environment Registry

The registry is data-driven. Adding an OS should mean adding or contributing an environment definition, not editing UI code.

## Definition vs local config

Repo or plugin definition:

- identifies the environment
- declares backend and capability requirements
- supplies boot defaults
- describes mounts and runtime expectations

Local config:

- maps environment ids to image paths
- selects cache/run roots
- stores host-specific overrides
- never changes what the environment means

## Environment definition shape

```toml
id = "linux/mint"
name = "Linux Mint"
family = "linux"
backend = "qemu"

[image]
kind = "qcow2"
base = "linux-mint-base.qcow2"
recommended_size_gb = 40

[boot]
memory_mb = 4096
cpus = 4
display = "gtk"
ssh_port = 2222

[mounts]
workspace = true
```

## Local config shape

```toml
image_root = "/media/kmrh47/WD_SN850X/qol-env/images"
run_root = "/media/kmrh47/WD_SN850X/qol-env/runs"

[images]
"linux/mint" = "linux-mint-base.qcow2"
"linux/ubuntu" = "ubuntu-base.qcow2"
"windows/11" = "windows-11-base.qcow2"
```

Local paths are examples. Implementations must allow the user to choose host-appropriate roots.

## Discovery

Search definitions from stable providers:

- app-owned flow definitions
- enabled plugin flow definitions
- local user definitions, if supported

Merge by environment id. Prefer failing on conflicting definitions unless the override layer is explicit.

## Resolver output

Each environment should resolve to exactly one state:

```json
{
  "id": "linux/mint",
  "state": "ready",
  "backend": "qemu",
  "image": "/path/to/image.qcow2",
  "run_root": "/path/to/runs",
  "capabilities": {
    "acceleration": "kvm",
    "display": "gtk",
    "shared_folder": "virtio-9p"
  },
  "messages": []
}
```

Use `missing` when the user can fix the issue by configuring/downloading an image. Use `unsupported` when this host cannot run the definition with available backends.

## UI rule

`qol dev` should show missing and unsupported entries. Hiding them makes the system feel arbitrary and prevents the user from learning what to fix.

