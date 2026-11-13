# Reaching a host server from the device

Use `portReverse` instead of running `adb reverse` yourself. It lets an app or
browser on an Android device reach a server on your machine at exactly
`http://localhost:<port>`, such as an OAuth redirect URI or a local mock backend.
[Port reverse internals](../how-it-works/plat/android/port-reverse.md) describes
how AutoMobile tracks mappings.

On iOS the tool returns `status: "not_applicable"`: a simulator shares the
host's network, so `localhost:<port>` already reaches your machine.

## Actions

### ensure

`ensure` with `ports: [{ devicePort, hostPort? }]` adds each mapping. `hostPort`
defaults to `devicePort`. Calling it again is a no-op.

With `reclaimStale: true`, `ensure` replaces a stale mapping instead of reporting
a conflict. A crashed session, a daemon restart, or another tool can leave such a
mapping behind. AutoMobile replaces it only when all of these hold:

- your session holds the device;
- no running session owns the mapping;
- its host side is `tcp:<H>`;
- nothing on your machine accepts a connection on port `H`.

That mapping's result carries `reclaimed: { host, reason: "host_refused" }`. When
adb talks to a server on another machine (`ANDROID_ADB_SERVER_ADDRESS` or
`ADB_SERVER_SOCKET`), AutoMobile cannot check host ports, so it reclaims nothing.

### list

`list` returns every reverse on the device:

| Field           | Meaning                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `owned: true`   | Your session created the mapping.                                                                              |
| `owner`         | `"prototype"` when a shown or saved prototype's `via: "device"` request uses it.                               |
| `hostListening` | Whether a server on your machine accepts connections on the mapping's `tcp:` host port; absent when unchecked. |

### deviceListener

`list` and `verify` give each port a `deviceListener`:

| Value                                | Meaning                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `{ kind: "none" }`                   | Nothing listens on the device port.                                                                           |
| `{ kind: "reverse" }`                | The reverse itself listens.                                                                                   |
| `{ kind: "process", uid, package? }` | An app or other process on the device holds the port; `package` is set when exactly one package has that uid. |
| `{ kind: "unsupported", detail }`    | The device would not show its listening sockets.                                                              |

### verify

`verify` reports whether each port has a mapping now. It checks all of your ports
by default. Ports without a mapping report `missing`, and AutoMobile does not probe
them.

With `probe: true` it also connects to each mapped port from the device. This
takes about a second, for all ports at once. Each port then reports one of:

- `reachable`: your host server accepted and kept the connection open.
- `unreachable`, with a `probeReason`: `closed` (the mapping exists but nothing
  listens on the host port), `refused` (nothing listens on the device port), or
  `timeout` (the device did not answer).
- `probe_unsupported`: the device shell has no usable connect command;
  `probeDetail` holds what it printed.

A host server that closes idle connections within a second reads as `closed`.

#### HTTP probe

A TCP connect succeeds for any server, including the wrong one on a reused host
port. To check that the right service answers, pass
`probe: { http: { path, expectStatus, hostHeader?, expectBodyContains?, timeoutMs? } }`.
The device sends `GET <path>` through each mapping and reports `httpStatus`.

A port is `reachable` when the status is in `expectStatus` and the body contains
`expectBodyContains`, when given. Otherwise it is `unreachable` with one of these
`probeReason` values:

| `probeReason`      | Meaning                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `http_status`      | Another status came back.                                                                                  |
| `http_body`        | The expected text is missing.                                                                              |
| `no_http_response` | The connection ended, or something answered, without an HTTP response; `probeDetail` shows what came back. |
| `refused`          | Nothing listens on the device port.                                                                        |
| `timeout`          | No answer in time. Responses over 256 KB are not read and also report `timeout`.                           |

| Parameter    | Rule                                                   |
| ------------ | ------------------------------------------------------ |
| `path`       | Must start with `/` and contain no spaces.             |
| `hostHeader` | Defaults to `localhost:<devicePort>`.                  |
| `timeoutMs`  | 1000-10000, default 2000, rounded up to whole seconds. |

### remove

`remove` deletes mappings your session created. A port a prototype also uses
reports `released`: your session no longer owns it, and it stays on the device
until the prototype is dismissed. Likewise, `ensure` on a prototype's port to the
same host port shares it (`present`) instead of conflicting.

## Lost mappings

AutoMobile owns the mappings it creates for your session. A mapping can disappear
after an adb server restart, `adb reconnect`, `adb root`/`unroot`, an emulator
restart, or `adb reverse --remove` run outside AutoMobile.

AutoMobile re-adds a lost mapping when it sees the device's adb connection
recover, or on its periodic check (every 30 s by default). Otherwise the next
`ensure`, `list` or `verify` call re-adds it. Either way, that next call lists it
in `restored`. A mapping AutoMobile could not re-add appears in
`restoreFailures`, and the next call retries it.

AutoMobile removes your mappings when your session is released or leaves the
device. Mappings made without a session stay until the device disconnects, and
AutoMobile stops tracking them then. A device that stays connected keeps them
until you run `adb reverse --remove`.

## Errors

Errors come back with `errorCode`:

| `errorCode`                       | Meaning and what to do                                                                                                                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port_reverse_conflict`           | Someone else already maps the device port, or it maps to another host port. Nothing changed; pick another port or remove the existing mapping. `conflicts` lists each port's `conflictKind` (see below).                                                                |
| `port_reverse_device_port_in_use` | A process on the device already listens on the device port, so the reverse cannot be added. The message names its uid and package; stop it or pick another device port.                                                                                                 |
| `port_reverse_reclaim_failed`     | `reclaimStale` found a stale mapping but could not remove it, or it changed just before removal. That mapping stays as it was and this call's new mappings roll back; a mapping the same call already reclaimed stays removed. Call `list` to see the current mappings. |
| `port_reverse_not_owned`          | `remove` named a port your session did not create. Nothing was removed.                                                                                                                                                                                                 |
| `port_reverse_port_refused`       | A port is below 1024 or outside `AUTOMOBILE_PORT_REVERSE_ALLOWED_PORTS`, or `ports` was missing.                                                                                                                                                                        |

`conflictKind` also appears at the top level when every port has the same one:

| `conflictKind`     | Meaning                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `other_session`    | Another running session owns the mapping.                                                                                    |
| `prototype`        | A prototype's request uses it, mapped to another host port.                                                                  |
| `external_live`    | Made outside AutoMobile, and its host port accepts connections.                                                              |
| `external_unknown` | Made outside AutoMobile, and its host port was not shown to be live. Retry with `reclaimStale: true` to replace it if stale. |
