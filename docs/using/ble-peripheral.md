# Virtual BLE peripherals

Use `blePeripheral` to prototype a wearable or smart lock against an Android emulator's Bluetooth stack. Acquire a daemon device session first and enable the tool with `setToolEnabled` if it is not listed. The host needs `python3` (Python 3.11 with venv support). The first start downloads the managed Bluetooth dependencies from PyPI; later starts reuse them.

Start with `{"action":"start","sessionUuid":"<session>","name":"Prototype","presets":["battery","heartRate"]}`. The result includes a session-owned `handle`, name, address, presets, transport, `running`, `advertising`, `connected`, `subscribed`, `pythonReady` and `bumbleReady`. Initial battery level is 87 and heart rate is 72 bpm.

`name` is the advertised local name, limited to 20 UTF-8 bytes. `address` defaults to `F0:F1:F2:F3:F4:F5`; choose distinct addresses for simultaneous peripherals. `deviceId` defaults to the calling session's emulator and must match that session. A private netsim instance is selected automatically when discoverable. `transport` explicitly overrides discovery, for example `android-netsim:localhost:12345`. Without a known private instance, the default is `android-netsim`.

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
- `stop`: `{"action":"stop","handle":"<handle>"}` kills the peripheral. Ending or unbinding the session, or shutting down the daemon, also kills it. Handles cannot be used by another session.

A connected peripheral stops advertising until disconnect. Advertising restarts automatically after disconnection; notifications continue while connected.

Advertisements include the selected battery and heart-rate service UUIDs. Discover custom service UUIDs after connecting; scan for their advertised local name rather than filtering by a custom service UUID.

If Python is missing, install Python 3.11 with venv support and ensure `python3` is on the daemon's PATH. `doctor` reports a warning when it is unavailable. Installation errors include the exact pip repair command; check access to PyPI before retrying. Transport errors require a running emulator with Bluetooth/netsim enabled; supply an explicit transport when host discovery is unavailable. A stopped or crashed sidecar requires a new start. Unknown handles require the original session and its returned handle.
