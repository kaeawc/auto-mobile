# Manual-test harness

Use the harness for a manual batch that needs isolated daemons, persistent stdio
proxy executions, direct control frames, or recording and stream sockets. It keeps
connection and evidence visible when testing ownership refusals, broker session
confinement, cancellation, and observer liveness.

Use `scripts/mcp-drive.ts` for a one-shot MCP plan. Use
[Live device acceptance](live-device-acceptance.md) for its signed, disposable
exact-device acceptance matrix and the broker lifecycle lane below; the harness
retains connection evidence, acceptance adds signed evidence assertions.

## Hard rules

- Never touch the resident daemon: its default socket, port 3000, or
  `~/.auto-mobile`. Run every client through `in-daemon-env.sh` or a harness CLI
  with the initialized private environment.
- Never use `pkill` or `killall`. Stop only daemons you started, using
  `private-daemon.ts stop` for that batch and daemon number.
- Broker batches never make sessionless device calls. A ready grant and live driver
  are required; pending or failed acquisition never falls back to generic acquisition.
  Broker clients refuse `startDevice`, `provisionDevice`, `getAndroid`, `getApple`,
  `killDevice`, device inventory resources, and `--allow-selector`.
- Release broker devices through `proxyN release --client NAME` or `broker1 down`.
  Zero pooling destroys the native device through the product journal; verify the
  terminal receipt and native absence before the next scenario. Never delete an
  AVD, simulator, directory, or batch evidence yourself, signal device processes,
  pass `force`, or use `adb emu kill` (it can hang under load).
- Record protected devices with repeatable `init --protect NAME_OR_ID`. Protection
  wins over ledger ownership; a broker-looking name alone never authorizes access
  or cleanup.
- Keep one actor per granted device and one broker daemon per batch. `start`
  refuses an already-live recorded PID; the broker owns its host lock in the
  private coordination namespace. Report unaccounted-inventory startup refusals;
  do not remove other devices to make startup pass. Private paths do not isolate
  the host's AVD/simulator set.
- For separate plain-proxy tests, device acquisition requires explicit `avdName`
  (Android) or `deviceId` (UDID/serial); `name` alone is a matcher and is refused.
  `--allow-selector` is only a deliberate selection-test override in plain mode.
- Never pass daemon flags to a stdio proxy (a startup-option mismatch can restart
  the daemon). Record daemon flags with `init --daemon-arg`, or one-off via
  `private-daemon.ts start --`.
- Never rebuild `dist/` while a batch's daemons run. Build first, then start the
  batch from one explicit entry script.

The harness is described across these pages:

- [Private daemons, path policy and staggered boots](manual-test-harness-daemons.md)
- [Devices, teardown, stdio-proxy sessions and raw frames](manual-test-harness-sessions.md)
- [Broker scenarios, auxiliary sockets, Python SDK clients and evidence](manual-test-harness-broker.md)

## Background

- [Manual-test batch incidents](../devlog/2026-10-23-manual-test-harness-batch-incidents.md)
