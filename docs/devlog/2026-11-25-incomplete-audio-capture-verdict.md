# An incomplete audio capture gives no silence verdict

- Kind: decision
- Date: 2026-11-25
- Source: #19182
- Shaped: [Emulator gRPC audio](../how-it-works/plat/android/emulator-grpc-audio.md)

## Context

`captureAudio` reported `success: true` and `silent: true` when the emulator gRPC audio stream
delivered no frames or stopped early, for example 0 of 2000 ms. The verdict read as "the device
played nothing", but nothing was measured. A silent guest can also send no frames, so the two
cases look the same to the client.

## Options

The issue proposed either `success: false`, or `complete: false` with `silent: null`, plus the
captured and requested length and a hint.

## Decision

Keep `success: true`, since the capture ran and a silent guest is not an error. Add `complete` and
`requestedMs`. An incomplete capture that heard no sound reports `silent: null`, and its message
gives the milliseconds that arrived with a hint to check the audio route. An incomplete capture
that did hear sound still reports `silent: false`, because that sound was measured.

## Consequences

Callers that asserted `silent: true` on a silent emulator app must accept `silent: null` with
`complete: false`, or play known audio first. `timedOut` stays for existing callers.
