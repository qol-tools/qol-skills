# Linux Bluetooth controller diagnostics

Source-checked 2026-07-13 against the [Bluetooth Core 6.3 HCI specification](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core_v6.3/out/en/host-controller-interface/host-controller-interface-functional-specification.html), the [BlueZ Device API](https://bluez.readthedocs.io/en/latest/device-api/), and the [Linux sysfs access rules](https://www.kernel.org/doc/html/latest/admin-guide/sysfs-rules.html). Inspect the plugin implementation and current system state before changing behavior.

## Resolve the adapter exactly

Adapter-sensitive diagnostics must identify the controller's real adapter before querying it.

1. Parse the physical evdev device's sysfs path. If its device hierarchy contains an `hci<digits>` component, use that adapter.
2. Virtual `uhid` input paths may not contain an adapter. For those, enumerate available Bluetooth adapters and query the BlueZ `org.bluez.Device1.Connected` property for the controller address under each adapter object path.
3. Cache a proven device-to-adapter association while the device remains active.
4. If no association can be proven, return no adapter and no adapter-bound signal. Never invoke `hcitool rssi` without `-i <adapter>` and let it guess the default adapter.

Treat `hci0`, `hci1`, and similar names as boot-specific handles. Present durable identity from udev vendor/model, USB vendor/product ID, and physical `ID_PATH`. A Bluetooth address may help a live UI disambiguate adapters, but do not persist a real address in profiles, fixtures, documentation, or logs. Use synthetic addresses in tests.

## Keep signal kinds separate

The plugin contract uses discriminated signal evidence:

| Kind | Source | Meaning | Unit |
| --- | --- | --- | --- |
| `absolute_dbm` | BlueZ `Device1.RSSI` | Inquiry or advertising RSSI reported for the remote device | dBm |
| `bredr_link_margin_db` | HCI Read RSSI, currently reached through adapter-bound `hcitool rssi` | BR/EDR position relative to the controller-selected receive-power range | dB relative to the range |

For BR/EDR HCI Read RSSI:

- positive means above the upper limit of the controller's target range;
- zero means inside the range;
- negative means below the lower limit;
- the value is not required to be an accurate absolute power measurement.

For LE HCI Read RSSI, the Core specification defines an absolute dBm result. Do not apply BR/EDR margin semantics to an LE reading.

Never compare `-11 dB below target` with `-55 dBm` numerically. Keep the kind and source in histories and IPC payloads, and reset or separate history when the kind changes.

## Present honest diagnostics

- Label absolute values as reported RSSI and show `dBm`.
- Label BR/EDR values as above, inside, or below the target range and show relative `dB`.
- Do not call either measurement packet quality, latency, or connection reliability.
- Make unavailable readings visible instead of carrying the last value forward as current.
- Keep adapter identity beside signal evidence so a user can tell which radio produced it.

A strong or in-range measurement can coexist with lag, dropped input, audio stutter, or reconnect failures. Those symptoms can also depend on interference, antenna pattern or damage, host scheduling, retransmissions, controller firmware, and protocol behavior. Signal history is evidence for diagnosis, not a verdict.

## Contract and tests

Keep native payload fields explicit:

```json
{
  "signal": { "kind": "bredr_link_margin_db", "source": "hci_link", "value": -11 },
  "adapter": { "name": "hci7", "hardware_id": "1234:abcd", "path": "physical-path" }
}
```

Use synthetic addresses and paths in tests. Pin:

- physical sysfs adapter extraction;
- virtual-device BlueZ fallback behavior;
- refusal to guess an adapter;
- BlueZ and HCI parser ranges;
- typed daemon JSON shape;
- browser normalization rejecting unknown kinds or invalid ranges;
- presentation and history that never mix dBm with relative dB.
