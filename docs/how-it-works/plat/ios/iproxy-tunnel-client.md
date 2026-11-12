# Physical iOS iproxy tunnel client

Physical-device CtrlProxy reaches the device through libusbmuxd's `iproxy`, behind the injected
`IosTunnelClient` interface. `FakeIosTunnelClient` drives deterministic manager tests without USB
hardware. There is no transport fallback.

## Ownership

`DefaultIosTunnelClient` owns:

- the child process and PID;
- local and device ports (the device port only for remote tunnels);
- argv-only launch, startup liveness polling and output capture;
- supervision and graceful/forced cleanup.

The manager owns runner sequencing and host-port allocation. Its callbacks keep the order stop →
host-port check → remote tunnel launch, and recover from `RemoteServicePortUnavailableError` through
the runner restart. A local tunnel's recorded port keeps runner launch and ownership checks aligned.

## Binary and prerequisites

`iproxy` is launched by name through the executor and resolved from the host's `PATH` (the remote
host's for remote execution). The binary's path, signature, version and provenance are not checked
or pinned, and logs make no claim about them. The `iproxy` installation and the connected USB device
are trusted host prerequisites; existing physical CtrlProxy prerequisites apply. No specific
Xcode/iOS/libusbmuxd combination is validated by the unit tests.

## Lifecycle and diagnostics

- Stdout/stderr excerpts are trimmed and capped at 500 characters each; no extra redaction.
- "Ready" means the process is alive, not an HTTP, TCP-bind or device-service readiness proof.
- `ProcessSupervisor` checks every 5 s and retries with exponential delay from 1 s, capped at 15 s.
  Retries are unlimited until stop or device disconnect. Stop cancels scheduled restarts.
- Startup failure keeps the original error type and text, and a tunnel launched before a readiness
  failure stays tracked.
- Stopping during readiness can race: a late successful status response can re-arm supervision.
- Exit-wait listeners are once-listeners.
- Local restarts use the current service port for both argv ports; remote restarts keep the
  recorded device port.
- Cleanup sends the graceful signal to the tracked child, waits 1 s, sends the forced signal, waits
  1 s; shutdown has a force-stop path and remote runners get a stop call. There is no process-tree
  discovery.

Physical USB disconnect, real port binding and host process cleanup are covered only by device
validation, not by unit tests (which use fake executors and `FakeTimer` for local and remote-runner
paths).

## Out of scope

Binary installation, version pinning, capability discovery, runner recovery ordering changes and
new tool schemas.

## Background

- [Keep iproxy behind a typed tunnel client](../../../devlog/2026-10-06-iproxy-tunnel-client.md)
