# iOS Simulator audio isolation

- Kind: decision
- Date: 2026-11-19
- Source: #13632, #18679
- Shaped: [iOS Simulator audio isolation](../how-it-works/plat/ios/simulator-audio-isolation.md)

## Context

`injectAudioInput` and `captureAudio` share one loopback pair as the host's default input and
output, so two concurrent simulators would hear each other. The spike checked what could separate
them and what a headless host constrains.

## Options

1. Serialize: one loopback pair as the host default, one audio test at a time per host. Needs no
   new code and is the current behavior.
2. Host defaults per slot: change the Mac's default devices before each test. The setting is
   shared by every simulator, so it cannot isolate concurrent runs.
3. Per-simulator pin: give each simulator its own input and output loopback device through
   CoreSimulator's per-device audio routing. This is the only option that isolates concurrent
   simulators.

## Decision

Keep option 1 as the supported route and reject option 2. Pursue option 3 only after two
measurements on a drained host with two real loopback pairs. The guest must hear its pinned
device while the other simulator stays silent, and a daemon-owned helper must receive frames
under the Microphone permission. If either fails, stay on option 1.

## Consequences

The `audio-loopback-helper` would then take explicit device UIDs instead of reading the host
defaults. Until the measurements exist, audio tests on one host run one at a time.
