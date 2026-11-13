# Python SDK

The Python SDK is an async client for the AutoMobile daemon. It can check and start
the daemon, and open an MCP session that lists tools, calls any tool by name, and
reads resources. It needs Python 3.10 or newer and has no third-party dependencies.

It is not on PyPI yet. Install it from a checkout of the repository:

```bash
pip install ./sdk/python
```

The SDK runs the `auto-mobile` command for daemon lifecycle, so AutoMobile itself
must be installed (`npm install -g @kaeawc/auto-mobile`), or pass another command
with `executable`.

## Quick start

```python
import asyncio
from auto_mobile import AutoMobile

async def main() -> None:
    client = AutoMobile()
    status = await client.ensure_running()
    async with client.session() as session:
        for tool in await session.list_tools():
            print(tool.name)
        result = await session.call_tool("listDevices", {"platform": "android"})
        print(result.raise_for_error().text)

asyncio.run(main())
```

## Client options

`AutoMobile(executable=..., env=..., cwd=...)`

| Option       | Meaning                                                                                                                                                                                                                                     | Default           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `executable` | Command that runs AutoMobile, as an argv list, for example `["npx", "-y", "@kaeawc/auto-mobile@latest"]`.                                                                                                                                   | `["auto-mobile"]` |
| `env`        | Variables layered over the current environment. They choose which daemon is used: set `AUTOMOBILE_AUX_SOCKET_DIR` (or `AUTOMOBILE_DAEMON_*_PATH`) for a separate daemon, as described in [environment variables](environment-variables.md). | none              |
| `cwd`        | Working directory for the commands; relative paths in `env` resolve against it.                                                                                                                                                             | current directory |

## Daemon lifecycle

- `await client.status()` returns a `DaemonStatus`. Its fields are `running`, `pid`,
  `port`, `socket_path`, `version`, `started_at` and `recovery`, with the full object as `raw`.
  Its `healthy` field is false when the daemon is down and AutoMobile cannot
  recover its identity.
- `await client.ensure_running(timeout=90)` returns the status of a running daemon,
  starting one first when none is running. The whole call, including start-up, is
  bounded by `timeout` seconds.

## Sessions

`client.session(session_id=None, device_id=None)` returns a session; use it with
`async with`, which runs the MCP handshake on entry and closes the session on exit.
The daemon must be running.

- **Session id.** Every request carries the same session id, so calls from one
  session share device bindings and tool settings. Pass `session_id` to resume a
  known id; otherwise a new UUID is used. Read it from `session.session_id`.
- **Device.** With `device_id`, calls to tools that take a `deviceId` argument get it
  added automatically, and a call that names a different `deviceId` raises
  `SessionBindingError` without being sent. Holding a device still follows
  [device ownership](device-ownership.md); `device_id` does not acquire it.
- **Closing.** `close()` only ends the client side. A device the session acquired is
  released by the daemon's normal idle and ownership rules.

| Method                       | Returns                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_tools()`               | `Tool` list: `name`, `description`, `input_schema`, `annotations`, `meta`.                                                                                                         |
| `call_tool(name, arguments)` | `ToolResult`: `content` blocks, `structured_content`, `is_error`, `meta`, and `text` (all text blocks joined). `raise_for_error()` raises `ToolCallError` when `is_error` is true. |
| `read_resource(uri)`         | `ResourceContents` list: `uri`, `mime_type`, `text`, and `blob` (decoded bytes).                                                                                                   |

Each method takes an optional `timeout` in seconds. With no timeout a call waits as
long as the tool runs. When a timeout expires, `asyncio.TimeoutError` is raised and
the connection is closed; cancelling the task also closes it. Either way the tool may
already have run, so check device state before repeating a control call.

## Errors

All errors derive from `AutoMobileError`. None of them include the daemon's access
token.

| Error                       | When                                                                                                                                                                                                                             | What to do                                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DaemonCommandError`        | An `auto-mobile --daemon` command failed, timed out, or the executable was not found.                                                                                                                                            | Read `exit_code` and `stderr_tail`; check `executable`.                                                                                                                              |
| `DaemonUnavailableError`    | The daemon is not running, cannot be reached, is shutting down, or is still starting past the deadline.                                                                                                                          | Call `ensure_running()`, or retry with a longer timeout.                                                                                                                             |
| `DaemonAuthenticationError` | No access token is published, the token file cannot be read or is unsafe (`UnsafeTokenFileError`: a symlink, not a regular file, another owner, or a mode other than `0600`), or the daemon refused the token after one re-read. | Make sure `env` names the same daemon the token belongs to (`AUTOMOBILE_AUX_SOCKET_DIR`); for `UnsafeTokenFileError`, replace the path with a regular file you own with mode `0600`. |
| `McpError`                  | The daemon returned a JSON-RPC error, for example an unknown tool. `code`, `data` are set.                                                                                                                                       | Fix the request.                                                                                                                                                                     |
| `ProtocolError`             | The reply was not valid MCP, or the daemon negotiated an unsupported protocol version.                                                                                                                                           | Update the SDK or AutoMobile so both are current.                                                                                                                                    |
| `SessionBindingError`       | The session is closed, or a call named a device other than the bound one.                                                                                                                                                        | Open a new session.                                                                                                                                                                  |
| `ToolCallError`             | Raised by `ToolResult.raise_for_error()` for a tool that ran and failed.                                                                                                                                                         | Read `text` for the tool's message.                                                                                                                                                  |

The SDK retries only requests that the daemon never ran:

- a refused access token (after re-reading it once)
- a daemon that is still starting
- a refused connection to a daemon that moved to another port

A connection that is reset or broken after it opened raises `DaemonUnavailableError`
without a retry, because the request may already have run. The next request looks up
the daemon's port again.

## Testing your code

`AutoMobile` accepts `runner` (runs the `auto-mobile` commands), `transport` (sends
HTTP requests) and `token_provider`. Pass fakes that implement the `CommandRunner`,
`HttpTransport` and `TokenProvider` protocols to test code that uses the SDK without
a daemon.
