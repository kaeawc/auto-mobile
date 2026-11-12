# Keep iproxy behind a typed tunnel client

- Kind: decision
- Date: 2026-10-06
- Source: moved from `how-it-works/plat/ios/iproxy-tunnel-client.md`; #10340
- Shaped: [Physical iOS iproxy tunnel client](../how-it-works/plat/ios/iproxy-tunnel-client.md)

## Context

The physical-device CtrlProxy tunnel was managed inline by the runner manager. The refactor put it
behind one typed client so manager tests could run without USB hardware.

## Options

1. Retain libusbmuxd's `iproxy` behind an injected `IosTunnelClient`.
2. Discover an Apple replacement mechanism.
3. Retire physical CtrlProxy.
4. Design an AutoMobile transport.

## Decision

Option 1. `DefaultIosTunnelClient` and `FakeIosTunnelClient` were added; no new dependency or
transport fallback. Options 2–4 were dropped. The refactor preserved existing lifecycle log lines
and levels, process-liveness readiness, supervisor timings, unlimited retries and the cleanup signal
sequence, and added no redaction or attempt limit.

## Consequences

The change was verified only with fake executors and `FakeTimer`, for local and remote-runner
tunnel paths. No physical-device, Xcode, iOS or libusbmuxd version matrix was exercised, so it
established no new supported Xcode/iOS combinations. Binary provenance and version pinning were not
addressed.
