# Virtual BLE peripherals

| Tool                          | What it does                                                    | Requires |
| ----------------------------- | --------------------------------------------------------------- | -------- |
| 📡 <code>blePeripheral</code> | Manage a session-owned virtual BLE peripheral on Android netsim | —        |

Use `blePeripheral` to prototype a wearable or smart lock against an Android emulator's Bluetooth stack. Acquire a daemon device session first and enable the tool with `setToolEnabled` if it is not listed. The host needs `python3` (Python 3.11 with venv support). The first start downloads the managed Bluetooth dependencies from PyPI; later starts reuse them.

Start with `{"action":"start","sessionUuid":"<session>","name":"Prototype","presets":["battery","heartRate"]}`. The result includes a session-owned `handle`, name, address, presets, transport, `transportShared`, `running`, `advertising`, `connected`, `subscribed`, `pythonReady` and `bumbleReady`. Initial battery level is 87 and heart rate is 72 bpm.

- `name` is the advertised local name, limited to 20 UTF-8 bytes.
- `address` defaults to `F0:F1:F2:F3:F4:F5`. Choose distinct addresses for simultaneous peripherals.
- `deviceId` defaults to the calling session's emulator and must match that session.

AutoMobile selects a private netsim instance automatically when it can discover one. Without a known private instance, the default is `android-netsim`, the host-wide netsim that every emulator shares. The optional `transport` only accepts `android-netsim` or `android-netsim:localhost:<port>`. It must match the transport discovered for the session's emulator. Otherwise start fails, and the error names the expected value.

## Shared and private netsim

By default emulators share one netsim, so every emulator on the host can see the peripheral. When the transport is the shared `android-netsim`, `start`, `status`, `notify` and `stop` results carry `transportShared: true` and a `warning`. To keep a peripheral visible only to its own emulator, set `AUTOMOBILE_EMULATOR_NETSIM_ISOLATION=true` for the daemon and launch the emulator through AutoMobile. Each newly launched emulator then gets a private netsim. The transport becomes `android-netsim:localhost:<port>`, and `transportShared` is `false`. Emulators that were already running keep the shared netsim until relaunched.

AutoMobile stops a private netsim when the emulator it launched exits. If the daemon is stopped first and the emulator is then killed outside AutoMobile, nothing is left to stop that netsim; it normally exits once its emulator disconnects. If a `netsimd -i <N>` process is still running after its emulator is gone, kill it.

## Custom GATT

For custom GATT, include `custom` in `presets` and supply `services`, for example:

```json
{
  "action": "start",
  "sessionUuid": "<session>",
  "name": "Lock",
  "presets": ["custom"],
  "services": [
    {
      "uuid": "12345678-0000-1000-8000-00805f9b34fb",
      "characteristics": [
        {
          "uuid": "12345678-0001-1000-8000-00805f9b34fb",
          "properties": ["read", "notify"],
          "initialValue": { "value": "locked", "encoding": "utf8" }
        }
      ]
    }
  ]
}
```

Use the same session and returned handle for subsequent calls:

- `notify`: `{"action":"notify","handle":"<handle>","characteristic":"battery","level":80}` or `"characteristic":"heartRate","bpm":95`. Custom characteristics take their UUID and `"value":{"value":"unlocked","encoding":"utf8"}` or `"value":{"value":"00ff","encoding":"hex"}`. Hex needs complete byte pairs. Notifications go only to subscribed centrals; custom characteristics must declare `notify`. Updating a custom value also changes its readable value.
- `status`: `{"action":"status","handle":"<handle>"}` reports current connections, subscriptions and sidecar readiness.
- `stop`: `{"action":"stop","handle":"<handle>"}` kills the peripheral. Handles cannot be used by another session.

## Keeping the session alive

A peripheral lives only as long as its session. Releasing, unbinding or idling out the session, or shutting down the daemon, kills it. See [Device ownership](device-ownership.md#when-a-session-is-released) for the release rules.

- **Owner never heartbeats:** the daemon releases the session through the lost-heartbeat path. That happens about 20 seconds after creation when the session set its own heartbeat timeout (about 5 seconds on the default timeout). After that, it happens once no control call arrives within the heartbeat timeout.
- **Owner heartbeats:** the daemon releases the session after the idle window (2 minutes by default) passes with no control call.
- **What counts as use:** every `blePeripheral` action, `status` included, is a control call. `setToolEnabled` counts only when it passes the session's `sessionUuid`. Heartbeats do not count.

While a central connects or a test runs, call `blePeripheral` `status` more often than the idle window to keep the session and its peripheral alive. An owner that heartbeats must keep heartbeating too, since `status` does not replace a lost heartbeat. An owner that never heartbeats must call `status` more often than the session's heartbeat timeout.

A connected peripheral stops advertising until disconnect. Advertising restarts automatically after disconnection; notifications continue while connected.

Advertisements include the selected battery and heart-rate service UUIDs. Discover custom service UUIDs after connecting; scan for their advertised local name rather than filtering by a custom service UUID.

If Python is missing or older than 3.11, install Python 3.11 with venv support and ensure `python3` is on the daemon's PATH. `doctor` reports a warning when it is unavailable. Installation errors include the exact pip repair command; check access to PyPI before retrying. Transport errors require a running emulator with Bluetooth/netsim enabled; retry once the emulator is fully running when host discovery is unavailable. A stopped or crashed sidecar requires a new start. Unknown handles require the original session and its returned handle.
