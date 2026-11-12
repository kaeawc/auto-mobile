# Emulator gRPC audio: transport choice and open questions

- Kind: decision
- Date: 2026-10-28
- Source: moved from `how-it-works/plat/android/emulator-grpc-audio.md`; #13628, #13629, #13634, #13635, #15770
- Shaped: [Emulator gRPC audio](../how-it-works/plat/android/emulator-grpc-audio.md)

## Context

`injectAudioInput` and `captureAudio` (#13628, #13629) need to move PCM into and out of a specific
Android emulator.

## Options

- The emulator's `EmulatorController` gRPC RPCs `injectAudio` and `streamAudio`, through the
  emulator's own audio forwarder.
- Host-mic passthrough (`-allow-host-audio`).
- A per-emulator PulseAudio/PipeWire sink.

## Decision

Use the gRPC RPCs. Each emulator has its own gRPC port, so two emulators cannot hear each other's
audio. Host-mic passthrough is not used.

## Consequences

- A per-emulator PulseAudio/PipeWire sink is a fallback only worth building if some supported
  environment cannot reach the gRPC port.
- Open questions that need a real emulator (#13634):
  - The minimum emulator version that ships both RPCs, and whether every CI image meets it.
  - Whether `injectAudio` fails loudly or silently no-ops on an emulator launched with `-no-audio`.
