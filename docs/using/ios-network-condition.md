# iOS Simulator network condition

`setDeviceState` with `networkCondition` and no `appId` slows down or cuts the network of a whole
iOS Simulator. It needs no network extension, no administrator rights and no MDM profile, so it
works on headless CI Macs.

## Apply a condition

Send a profile, overrides, or both:

```json
{ "networkCondition": { "profile": "3g" } }
```

```json
{
  "networkCondition": {
    "profile": "none",
    "delayMs": 300,
    "downloadKbps": 1000,
    "uploadKbps": 1000
  }
}
```

| Field                        | Effect on the simulator                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `profile: "offline"`         | Every new connection fails at once                                     |
| `veryBad`, `2g`, `3g`, `4g`  | The profile's documented latency, bandwidth and loss                   |
| `delayMs`                    | Added latency per connection setup and per request/response turnaround |
| `downloadKbps`, `uploadKbps` | Bandwidth caps (`0` is unlimited)                                      |
| `packetLossPercent`          | Percent of new connections that time out and of UDP datagrams dropped  |
| `profile: "none"` or `reset` | Normal network                                                         |

The condition covers every process in the simulator: your app, `WKWebView` and Safari, and system
services. Traffic to `localhost` is never shaped.

## The first call reboots the simulator

The first degrading call on a simulator shuts it down and boots it again with the shaper. The
result has `rebooted: true` and a `warning`; running apps were closed, so launch the app under
test again. Later calls change the condition within a quarter second, with no reboot
(`rebooted: false`).

## Result

The result reports `backend: "socket-shaper"`, `scope: "device"`, `appliedProfile` and the applied
`values`. `getDeviceState` with `include: ["networkCondition"]` returns the current values and
`offline`.

## Restore

A session restores the normal network when it is released or rebinds. With `expiresInSeconds`,
the condition is reset when the time runs out. Outside a session, send `reset: true` yourself.

## One app instead of the whole simulator

With `appId`, `networkCondition` takes only that app offline through the network-filter extension.
That path needs the extension installed and approved; see
[Managed Macs and CI runners](managed-macs.md).

## Errors

| Error                                     | What to do                                                     |
| ----------------------------------------- | -------------------------------------------------------------- |
| `iOS network shaper compiler unavailable` | Install Xcode on the host, then retry                          |
| `Rebooting the iOS Simulator ... failed`  | Check the simulator boots with `xcrun simctl boot`, then retry |
| `... does not carry the network shaper`   | The simulator booted unshaped; retry, or erase the simulator   |

Physical iOS devices return `unsupported`.
