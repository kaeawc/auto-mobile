# Physical iOS iproxy tunnel client

## Decision

Option 1 is chosen: retain libusbmuxd's `iproxy` behind an injected
`IosTunnelClient`. `DefaultIosTunnelClient` owns the child/PID, local and device
ports, argv-only launch, startup liveness polling, output capture, supervision,
and graceful/forced cleanup. `FakeIosTunnelClient` supports deterministic manager
tests without USB hardware. No new dependency or transport fallback is added.

The manager still owns runner sequencing and host-port allocation. Its callbacks
preserve the stop → host-port check → remote tunnel launch sequence, and preserve
`RemoteServicePortUnavailableError` recovery through the existing runner restart.
A local tunnel's recorded port keeps runner launch and ownership checks aligned.

## Support and provenance

This change verifies unit behavior using fake executors and `FakeTimer`, for local
and remote-runner tunnel paths. No physical-device, Xcode-version, iOS-version,
or libusbmuxd-version matrix was exercised here. It therefore establishes no new
supported Xcode/iOS combinations; existing physical CtrlProxy prerequisites apply.

The binary is requested as `iproxy` through the existing executor, resolved by the
host's PATH (the remote host for remote execution). Binary provenance/version
pinning is NOT done here. Diagnostics explicitly mark the version as unverified;
they do not claim an inspected absolute binary path, signature, or provenance.
The installation and connected USB device remain trusted host prerequisites.

## Lifecycle and diagnostics

Lifecycle log records include the requested binary, UDID, local/device ports,
and start, ready, exit, and restart events. Existing stdout/stderr logging trims
whitespace and caps each excerpt at 500 characters; no additional redaction work
is introduced. Ready retains the existing process-liveness definition, rather
than claiming an HTTP, TCP-bind, or device-service readiness proof.

The existing `ProcessSupervisor` checks every five seconds and retries with
exponential delay from one second, capped at fifteen seconds. Retry count remains
unlimited until stop or device disconnect; this refactor does not add an attempt
limit. Stop cancels scheduled restarts. Startup failure surfaces an actionable
error and cleans the owned tunnel; stopping during readiness prevents a late
successful status response from rearming supervision. Exit-wait listeners are
removed after each graceful/forced wait.

Cleanup retains the existing tracked-child graceful signal, one-second wait,
forced signal, and one-second wait, plus the shutdown force-stop path and
remote-runner stop call. It does not introduce a new process-tree discovery or
signaling algorithm. Physical USB disconnect, actual port binding, and host
process cleanup still require device validation.

## Non-goals

Options 2–4 are dropped: discovering an Apple replacement mechanism, retiring
physical CtrlProxy, and designing an AutoMobile transport. Binary installation,
version pinning, capability discovery, changes to runner recovery ordering, and
new tool schemas are outside this change.
