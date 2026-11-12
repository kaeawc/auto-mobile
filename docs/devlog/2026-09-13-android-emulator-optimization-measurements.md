# Android emulator optimization measurements

- Kind: concept
- Date: 2026-09-13
- Source: moved from `how-it-works/android-emulator-optimization.md`; #6800
- Shaped: [Android emulator optimization](../how-it-works/android-emulator-optimization.md)

Preliminary local measurements from when the resource catalog and emulator hardware fields were added
(#6800). Not a benchmark.

## Results

On a disposable Android 15 Google APIs arm64 emulator (2 vCPU, 2048 MB, headless,
GPU auto = SwiftShader, macOS), disabling animations, screensavers, Gmail, YouTube,
Photos, Wellbeing and printing left median emulator RSS unchanged (4691.5 MiB before,
4693.1 MiB after; 52 baseline vs 60 treatment samples). No repeated A/B/A, unrelated
host work was running, and CPU percentages from the sampler are not used to claim a
reduction.

Mechanism checks on the API-35 image: 18 of 21 optional package groups disabled and
restored (Assistant, Dialer, Messages protected as active role holders); Maps'
background app-op (`ignore`/`default`), standby bucket (10/45/10), forced deep Doze,
a root-only `statsd` stop/restart, and speed-profile compilation all worked. These
prove command availability and limited reversible transitions, not performance wins,
and nothing was added to the public catalog from them. Persisted hardware fields
(720x1280, 280 dpi, two CPUs, no cameras, audio off, `gpuMode: host`) booted and
rendered correctly; resolution, renderer and boot state changed together, so this is
control validation, not a GPU comparison.
