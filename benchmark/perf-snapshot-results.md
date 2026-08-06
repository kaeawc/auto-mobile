# perfSnapshot overhead + window-sizing benchmark (#5077)

Harness: [`benchmark/perf-snapshot-overhead.ts`](./perf-snapshot-overhead.ts). Drives a
fast navigation loop across heavy Android Settings panels (long scrollable lists), issuing
back-to-back `observe` calls, comparing the flag OFF baseline against ON across window sizes.
Run it with a booted emulator + CtrlProxy:

```bash
BENCH_DEVICE_ID=emulator-5554 bun run benchmark/perf-snapshot-overhead.ts
```

## Representative run (emulator-5554, Pixel-class AVD, 25 iterations/cell)

| cell     | observe median (ms) | Δ vs OFF | fps p50/p95/p99 | samples | fps p50 σ |
|----------|--------------------:|---------:|-----------------|--------:|----------:|
| OFF      | 27.1                | —        | —               | —       | —         |
| ON@1000  | 29.3                | +2.2     | 52.6/52.6/52.6  | 2       | 2.90      |
| ON@2000  | 28.4                | +1.3     | 59.4/60/60      | 4       | 2.05      |
| ON@5000  | 29.3                | +2.2     | 59.4/60/60      | 10      | 0.35      |
| ON@10000 | 30.1                | +3.0     | 60/60/60        | 19      | 0.54      |
| ON@30000 | 32.1                | +5.0     | 60/60/60        | 44      | 0.00      |

Pure `PerfWindowBuffer.snapshot()` compute (device-independent):

| window (ms) | samples | ns/call |
|------------:|--------:|--------:|
| 1000        | 2       | ~700    |
| 5000        | 10      | ~900    |
| 10000       | 20      | ~1200   |
| 30000       | 60      | ~4400–5500 |

## Findings

1. **Observe overhead is device-noise-level, not window-driven.** Re-running the matrix in
   reverse window order scrambled the Δ ranking entirely (mid windows then showed the largest
   Δ, with p95 outliers up to ~450ms) — i.e. the apparent "grows with window" Δ in a single
   forward pass is emulator thermal/background drift, not the feature. The definitive evidence
   is the micro-benchmark: `snapshot()` costs **0.5–5.5 µs** even at a 30 s / 60-sample window,
   which cannot account for millisecond-scale swings on a ~27 ms observe. The only real
   recurring cost the feature adds is the concurrent 500 ms `dumpsys` sampler competing for the
   device — inherent to the opt-in, and window-independent.

2. **5000 ms is the right default window — data confirms the current value.** It is the
   smallest window that yields a *stable, genuine* percentile spread (~10 samples, fps p50 σ
   ≈ 0.35). Below it, 1000–2000 ms hold only 2–4 samples, so p95/p99 collapse onto a single
   reading and σ is unreliable (0.3 → 16 depending on conditions). Above it, 10 s/30 s are
   stable but over-smoothed — 44 samples spanning ~22 s lag fast screen transitions — for no
   fidelity gain and marginally more compute. **No change to `DEFAULT_PERF_WINDOW_MS`.**

3. **No perf fix required in the snapshot path.** Compute is µs-scale; `record()` is O(1)
   with a bounded splice at the 512-sample cap. Optimizing the few O(n≤60) passes in
   `snapshot()` would trade readability for an unmeasurable gain (YAGNI).

### Caveat for very small windows

Windows near the 1000 ms clamp floor are only meaningful when a *denser* sample source feeds
the buffer (e.g. a future on-device SDK FrameMetrics feed, #5076). At today's 500 ms host-side
tier they produce degenerate percentiles; the clamp floor is kept for that future source rather
than lowered further, and the default stays at 5000 ms.
