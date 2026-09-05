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

| | |
| --- | --- |
| **Path** | `/tmp/auto-mobile-daemon-<uid>.sock`, where `<uid>` is your OS user id (per-user socket). Override with `AUTOMOBILE_DAEMON_SOCKET_PATH`. |
| **Framing** | Newline-delimited JSON (NDJSON): one JSON request object per line terminated by `\n`; the daemon replies with one JSON line per request. |
| **Correlation** | Each response carries the `id` of its request, so a client may pipeline requests and match replies by `id`. |

### Request envelope

```json
{ "id": "1", "type": "daemon_request", "method": "input/tap", "params": { }, "timeoutMs": 10000 }
```

`type` is `"daemon_request"` for every input command. `timeoutMs` is optional
(default 60000).

### Response envelope

```json
{ "id": "1", "type": "mcp_response", "success": true, "result": { } }
```

On failure `success` is `false` and `error` holds a human-readable message.

## Input commands

Every command's `params` takes `platform` (`"android"` or `"ios"`) and an
optional `deviceId` — omit `deviceId` to target the daemon's active device. All
coordinates are **canonical device pixels**.

| `method` | `params` |
| --- | --- |
| `input/tap` | `x`, `y`, `duration?` |
| `input/swipe` | `startX`, `startY`, `endX`, `endY`, `durationMs` |
| `input/pressButton` | `button` (e.g. `back`, `home`, `recent`) |
| `input/key` | `key` (e.g. `enter`, `tab`, `arrow_up`) — Android only |
| `input/typeText` | `text`, `append`, `submit` |
| `input/gestureStart` · `input/gestureMove` · `input/gestureEnd` | `gestureId`, `x`, `y`, `cancel?` — Android streaming drag |

Two rules to get right:

- **`input/typeText` should set `append: true`** for per-keystroke typing. The
  default replaces the whole field, so appending one character at a time would
  otherwise wipe existing text on each keystroke.
- **`frameContext` is optional but recommended.** Pass the id of the frame you
  mapped the coordinate against (from the device data stream); the daemon then
  rejects the command if that frame is stale, catching a tap mapped through an
  out-of-date screenshot. Omit it and the staleness guard is skipped.

## Client examples

Each example connects to the socket, sends one `input/tap`, reads the response
line, and checks `success`. Swipes, buttons, keys, and text use the same
envelope with a different `method` and `params`.

=== "Kotlin"

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

=== "Go"

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

=== "TypeScript"

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

=== "Python"

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

## Sending other commands

Swap `method` and `params` in the same envelope:

```json
{"id":"2","type":"daemon_request","method":"input/swipe","params":{"platform":"android","startX":540,"startY":1600,"endX":540,"endY":400,"durationMs":300}}
{"id":"3","type":"daemon_request","method":"input/pressButton","params":{"platform":"android","button":"back"}}
{"id":"4","type":"daemon_request","method":"input/typeText","params":{"platform":"android","text":"hello","append":true,"submit":false}}
```

The reference client that ties click/drag/keyboard mapping to these commands is
`DeviceControlSession`
([source](https://github.com/kaeawc/auto-mobile/blob/main/android/desktop-core/src/main/kotlin/dev/jasonpearson/automobile/desktop/core/control/DeviceControlSession.kt)) —
consult it for the ordered dispatch queue and the post-input refresh wait.
