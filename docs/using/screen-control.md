# Screen control

Screen control means turning a click, drag, or keystroke on a mirrored device
screen into real device input. A client does this by sending typed **input
commands** to the AutoMobile daemon's Unix domain socket. This page documents
that socket wire protocol and shows minimal clients in four languages.

For the geometry — how to convert a click on your rendered canvas into the device
coordinates these commands expect — see the
[coordinate mapping contract](../design-docs/mcp/daemon/screen-control-mapping.md).
This page assumes you already have a device coordinate to send.

## The socket

|                 |                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Path**        | `/tmp/auto-mobile-daemon-<uid>.sock`, where `<uid>` is your OS user id (per-user socket). Override with `AUTOMOBILE_DAEMON_SOCKET_PATH`. |
| **Framing**     | Newline-delimited JSON (NDJSON): one JSON request object per line terminated by `\n`; the daemon replies with one JSON line per request. |
| **Correlation** | Each response carries the `id` of its request, so a client may pipeline requests and match replies by `id`.                              |

### Request envelope

```json
{
  "id": "1",
  "type": "daemon_request",
  "method": "input/tap",
  "params": { "platform": "android", "x": 540, "y": 960 },
  "timeoutMs": 10000
}
```

`type` is `"daemon_request"` for every input command. `timeoutMs` is optional
(default 30000 milliseconds for input commands).

### Response envelope

```json
{ "id": "1", "type": "mcp_response", "success": true, "result": {} }
```

On failure `success` is `false` and `error` holds a human-readable message.

## Input commands

Every command requires `platform`. Tap, swipe, pressButton, and typeText accept
`"android"` or `"ios"`; gestures and `input/key` require `"android"`.
`deviceId` is an optional string: when it
is omitted, the daemon uses the socket session's autolocked device for that
platform, otherwise the single booted device of that platform. With multiple
booted devices and no autolock, you must supply `deviceId`; with none, the
request fails. All coordinates are finite numbers in **canonical device pixels**.

Every command also accepts an optional `sessionUuid` string naming the daemon
session that sends it. A device that a session holds takes input only from that
session: a command for it without `sessionUuid`, or naming a different session,
fails with `code` `device_owned_by_other_session`. A device no session holds
takes input from any client.

In the table, `?` marks optional parameters.

| `method`             | `params`                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `input/tap`          | `platform`, `deviceId?`, `x`, `y`, `duration?`, `frameContext?`                                                                               |
| `input/swipe`        | `platform`, `deviceId?`, `startX`, `startY`, `endX`, `endY`, `durationMs?`, `frameContext?`                                                   |
| `input/pressButton`  | `platform`, `deviceId?`, `button`, `frameContext?` (e.g. `home`, `back`, `menu`, `power`, `volume_up`, `volume_down`, `recent`, `app_switch`) |
| `input/key`          | `platform`, `deviceId?`, `key`, `frameContext?` (e.g. `enter`, `tab`, `arrow_up`) — Android only                                              |
| `input/typeText`     | `platform`, `deviceId?`, `text`, `mode?`, `submit?`, `frameContext?`                                                                          |
| `input/gestureStart` | `platform`, `deviceId?`, `gestureId`, `x`, `y`, `cancel?` — Android streaming drag                                                            |
| `input/gestureMove`  | `platform`, `deviceId?`, `gestureId`, `x`, `y`, `cancel?` — Android streaming drag                                                            |
| `input/gestureEnd`   | `platform`, `deviceId?`, `gestureId`, `x`, `y`, `cancel?` — Android streaming drag                                                            |

### Button support

| Button        | Android | iOS |
| ------------- | ------- | --- |
| `home`        | Yes     | Yes |
| `back`        | Yes     | Yes |
| `menu`        | Yes     | No  |
| `power`       | Yes     | Yes |
| `volume_up`   | Yes     | Yes |
| `volume_down` | Yes     | Yes |
| `recent`      | Yes     | Yes |
| `app_switch`  | Yes     | Yes |

`app_switch` is an alias of `recent`. Button availability can also depend on the
device and its runner; iOS has no menu hardware button.

`duration` for taps is an optional integer number of milliseconds.
`durationMs` for swipes is an optional integer between 1 and 60000 milliseconds;
it defaults to 300 milliseconds.

All three gesture methods require a non-empty string `gestureId` and numeric
`x`/`y`. Send a start, moves, and an end with the same `gestureId`. The parser
accepts an optional boolean `cancel` on all three, defaulting to false, but only
`gestureEnd` forwards it to the runner; start and move ignore it.

Two rules to get right:

- **`input/typeText` should set `mode: "append"`** for per-keystroke typing.
  This is the only accepted value of `mode`; omit it to replace the whole field.
  `text` must be a non-empty string. `submit` is an optional boolean, defaulting
  to false.
- **`frameContext` is optional but recommended for tap, swipe, typeText,
  pressButton, and key.** Pass the non-empty context string reported by the
  device data stream for the frame you used. The daemon rejects the command if
  the newest device context differs or is unavailable; observe a fresh frame
  before retrying. Omit it and this check is skipped. Gesture commands do not
  validate or enforce `frameContext`.

## Client examples

Each example shows how to connect to the socket, send one `input/tap`, and read
a response. Inspect `success` before treating the input as successful. Swipes,
buttons, keys, and text use the same envelope with a different `method` and
`params`.

<div class="content-tabs" markdown>

### Kotlin

Uses JDK 16+ Unix domain sockets. `UnixSystem` supplies the uid.

```kotlin
import com.sun.security.auth.module.UnixSystem
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.ByteBuffer
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets

fun tap(x: Int, y: Int) {
    val uid = UnixSystem().uid
    val path = "/tmp/auto-mobile-daemon-$uid.sock"
    SocketChannel.open(StandardProtocolFamily.UNIX).use { channel ->
        channel.connect(UnixDomainSocketAddress.of(path))

        val request = """
            {"id":"1","type":"daemon_request","method":"input/tap",
             "params":{"platform":"android","x":$x,"y":$y}}
        """.trimIndent().replace("\n", "") + "\n"
        channel.write(ByteBuffer.wrap(request.toByteArray(StandardCharsets.UTF_8)))

        val buffer = ByteBuffer.allocate(8192)
        channel.read(buffer)
        buffer.flip()
        val response = StandardCharsets.UTF_8.decode(buffer).toString().trim()
        println(response) // {"id":"1","type":"mcp_response","success":true,...}
    }
}
```

### Go

```go
package main

import (
    "bufio"
    "encoding/json"
    "fmt"
    "net"
    "os"
)

func tap(x, y int) error {
    path := fmt.Sprintf("/tmp/auto-mobile-daemon-%d.sock", os.Getuid())
    conn, err := net.Dial("unix", path)
    if err != nil {
        return err
    }
    defer conn.Close()

    req := map[string]any{
        "id":     "1",
        "type":   "daemon_request",
        "method": "input/tap",
        "params": map[string]any{"platform": "android", "x": x, "y": y},
    }
    line, _ := json.Marshal(req)
    if _, err := conn.Write(append(line, '\n')); err != nil {
        return err
    }

    resp, err := bufio.NewReader(conn).ReadString('\n')
    if err != nil {
        return err
    }
    fmt.Print(resp) // {"id":"1","type":"mcp_response","success":true,...}
    return nil
}
```

### TypeScript

Works in Node and Bun.

```ts
import { createConnection } from "node:net";
import { userInfo } from "node:os";

function tap(x: number, y: number): Promise<unknown> {
  const path = `/tmp/auto-mobile-daemon-${userInfo().uid}.sock`;
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path }, () => {
      const request = {
        id: "1",
        type: "daemon_request",
        method: "input/tap",
        params: { platform: "android", x, y },
      };
      socket.write(JSON.stringify(request) + "\n");
    });

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, newline)));
      }
    });
    socket.on("error", reject);
  });
}
```

### Python

```python
import json
import os
import socket


def tap(x: int, y: int) -> dict:
    path = f"/tmp/auto-mobile-daemon-{os.getuid()}.sock"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.connect(path)
        request = {
            "id": "1",
            "type": "daemon_request",
            "method": "input/tap",
            "params": {"platform": "android", "x": x, "y": y},
        }
        sock.sendall(json.dumps(request).encode() + b"\n")

        buffer = b""
        while b"\n" not in buffer:
            buffer += sock.recv(8192)
        return json.loads(buffer.split(b"\n", 1)[0])
        # {"id": "1", "type": "mcp_response", "success": True, ...}
```

</div>

## Sending other commands

Swap `method` and `params` in the same envelope:

```json
{"id":"2","type":"daemon_request","method":"input/swipe","params":{"platform":"android","startX":540,"startY":1600,"endX":540,"endY":400,"durationMs":300}}
{"id":"3","type":"daemon_request","method":"input/pressButton","params":{"platform":"android","button":"back"}}
{"id":"4","type":"daemon_request","method":"input/typeText","params":{"platform":"android","text":"hello","mode":"append","submit":false}}
```

The reference client that ties click/drag/keyboard mapping to these commands is
`DeviceControlSession`
([source](https://github.com/kaeawc/auto-mobile/blob/main/android/desktop-core/src/main/kotlin/dev/jasonpearson/automobile/desktop/core/control/DeviceControlSession.kt)) —
consult it for the ordered dispatch queue and the post-input refresh wait.
