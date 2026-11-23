# iOS Simulator network activity

`getDeviceState` with `include: ["networkActivity"]` lists which processes on an iOS Simulator have
internet sockets open and how many bytes moved on them. It needs no network extension, root or
approval, so it works on any Mac host and on CI.

```json
{ "include": ["networkActivity"] }
```

## Result

`networkActivity.processes` has one entry for each simulator process with an internet socket or
traffic:

| Field      | Meaning                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pid`      | Process id on the host.                                                                                                                |
| `name`     | Process name.                                                                                                                          |
| `appId`    | Bundle id of the installed app that holds the executable, app extensions included. Absent for system daemons.                          |
| `sockets`  | Each socket's `protocol` (`TCP` or `UDP`), `local` and `remote` address, and TCP `state` (`ESTABLISHED`, `LISTEN`, `CLOSE_WAIT`, ...). |
| `bytesIn`  | Bytes received on the sockets open at read time.                                                                                       |
| `bytesOut` | Bytes sent on the sockets open at read time.                                                                                           |

`networkActivity.processCount` is the number of processes the simulator runs, active or not.

```json
{
  "pid": 15965,
  "name": "NetProbe",
  "appId": "dev.automobile.netprobe19020",
  "sockets": [
    {
      "protocol": "TCP",
      "local": "127.0.0.1:62949",
      "remote": "127.0.0.1:47120",
      "state": "ESTABLISHED"
    }
  ],
  "bytesIn": 2424879,
  "bytesOut": 207
}
```

## What the numbers mean

- Byte counts cover the sockets that are open when you call. A request that already finished and
  closed its connection is not in the totals. To measure a download, read while it runs, or read
  twice and compare a connection that stays open.
- Web content in Safari and in `WKWebView` loads through the system `com.apple.WebKit.Networking`
  process, which has no `appId`. Look for it by `name`.
- Traffic that stays on the simulator, such as AutoMobile's own runner connection on `127.0.0.1`,
  is listed like any other socket.

## Checking a network condition

After `setDeviceState` sets a network condition, read `networkActivity` to confirm the effect,
for example that an app opens no new `ESTABLISHED` connection while it is offline.

## Errors

| Result                                | What to do                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `unsupported` lists `networkActivity` | The device is Android or a physical iPhone; only an iOS Simulator is supported. |
| `error` says no processes were found  | The simulator is not booted. Boot it and call again.                            |
| `error` says the read failed          | A host tool (`ps`, `lsof` or `nettop`) failed or timed out. Call again.         |
