# Emulator gRPC audio on real emulators: runs and open questions

- Kind: concept
- Date: 2026-11-20
- Source: moved from `how-it-works/plat/android/emulator-grpc-audio.md` ("Verified on real emulators", added by #18686); runs recorded on #13634; review follow-up #18835
- Shaped: [Emulator gRPC audio](../how-it-works/plat/android/emulator-grpc-audio.md)

## Runs

Two manual runs on #13634, each with two concurrent emulators on a macOS arm64 host:

- 2026-10-30: `emulator 37.1.11.0` (build 15917651), API 36 and API 37 images, through the tools.
- 2026-11-17: `emulator 37.2.13.0` (build 16740729), headless AVDs at API 36 and API 35
  (google_apis arm64), driven through `EmulatorAudioClient` directly. A used `-grpc-use-token` and B
  used JWT.

## What the runs show

- **Capture isolation was observed.** With a 1 kHz tone playing in B's guest, `streamAudio` ran on
  both at once. B returned `silent: false` (RMS about -38 dBFS) and A returned `silent: true` with
  `timedOut: true`. Both builds gave this result.
- **Injection isolation is unverified.** Injecting into either emulator left the other's endpoint
  and credential untouched, but no run measured whether injected audio reached only its own guest.
- **The emulator accepts injected packets; consumption is not shown.** `framesPlayed` is computed
  by the client (`EmulatorAudioClient.framesPlayed()`): elapsed time since the first packet at the
  clip rate, capped at `framesQueued`. The emulator sends no playback ack. The 2026-11-17 runs
  reported `framesPlayed` at about 94% of `framesQueued` (for example 271031 of 288000), which is
  an estimate of what was played. It is not evidence that the emulator consumed the packets. What
  the runs do show is that the RPC accepted the stream and completed.
- **`-no-audio` does not fail injection.** On both builds an emulator launched with `-no-audio`
  accepted and completed an injection, so the host cannot detect the flag from an RPC error.
- **`-no-audio` capture differs by build.** On 37.1.11 a guest-played tone was captured from a
  `-no-audio` emulator (peak -29.3 dBFS). On 37.2.13 the `-no-audio` emulator A returned no frames
  and timed out. That run played the tone only in B, so it does not show whether capture works
  under `-no-audio` on 37.2.13.
- **A second concurrent `injectAudio` is rejected** by the emulator with `FAILED_PRECONDITION`.
  Through the tools the service's own reservation answers first.
- **`injectAudio` without an open guest `AudioRecord` crashes the emulator** on 37.2.13 (SIGSEGV,
  null dereference in `QemuAudioInputEngine::start`). This is why every client holds the
  guest-capture lease (#18687).
- **Token, JWT and plain `-grpc` all worked** for both RPCs on 37.2.13. On 37.1.11 the JWT flow
  failed (#16026).

## Open questions

- Whether injected content arrives in the guest. The CtrlProxy recorder discards PCM and `tinycap`
  cannot open the guest sound card, so this needs a recorder that measures level.
- Whether capture works under `-no-audio` on 37.2.13.
- The minimum emulator build that ships both RPCs. Finding it needs older emulator packages.
