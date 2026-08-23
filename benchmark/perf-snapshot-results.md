# perfSnapshot overhead + window-sizing benchmark (#5077)

Harness: [`benchmark/perf-snapshot-overhead.ts`](./perf-snapshot-overhead.ts). Drives a
fast navigation loop across heavy Android Settings panels (long scrollable lists), issuing
back-to-back `observe` calls, comparing the flag OFF baseline against ON across window sizes.
Run it with a booted emulator + CtrlProxy:

```bash
BENCH_DEVICE_ID=emulator-5554 BENCH_REPEATS=1 bun run benchmark/perf-snapshot-overhead.ts
```

**Counterbalanced methodology.** Each ON window is measured against a **fresh OFF baseline run
immediately before it** (paired), so slow drift — thermal state, caches, navigation position —
largely cancels in the per-window delta instead of masquerading as a window-size effect. The
whole matrix repeats `BENCH_REPEATS` times with the ON windows alternating direction each pass,
and every cell's execution `order` is written to the raw JSON. The **device-independent**
micro-benchmark of `PerfWindowBuffer.snapshot()` is the definitive overhead evidence, since the
device numbers move with emulator load.

## Representative run (emulator-5554, 18 iterations/cell, paired)

Absolute observe latency depends heavily on emulator load (a busy host inflates every cell);
what matters is that the **paired Δ stays noise-dominated** — it swings both ways across windows
and does not grow with window size — while `snapshot()` compute stays µs-scale.

| window (ms) |        paired Δ (ms) | fps p50/p95/p99           | samples |   fps p50 σ |
| ----------: | -------------------: | ------------------------- | ------: | ----------: |
|        1000 |             −57 … +2 | collapses to 1–2 readings |       2 |      2.9–17 |
|        2000 |             −10 … +1 | 3–4 readings              |       4 |         2–5 |
|        5000 | ~0 … +2 (clean host) | genuine p50–p99 spread    |     ~10 | **0.3–0.5** |
|       10000 |       drift-tracking | stable but lagging        |     ~19 |       0.5–8 |
|       30000 |       drift-tracking | stable, over-smoothed     |     ~44 |         0–2 |

(Ranges span a clean-host run and a load-contended run; the sign of the paired Δ flips with host
state, confirming it is not window-driven.) The **fps p50 σ** column is _within-run_ output
variability across one run's overlapping snapshots — illustrative, not cross-run repeatability
(use `BENCH_REPEATS≥2` for that). The window decision below rests on device-independent sample
arithmetic, not on this σ.

Pure `PerfWindowBuffer.snapshot()` compute (device-independent):

| window (ms) | samples |    ns/call |
| ----------: | ------: | ---------: |
|        1000 |       2 |       ~700 |
|        5000 |      10 |       ~900 |
|       10000 |      20 |      ~1200 |
|       30000 |      60 | ~4400–5500 |

## Findings

1. **Observe overhead is device-noise-level, not window-driven.** With the counterbalanced
   paired matrix the per-window Δ has no consistent relationship to window size — its sign flips
   with host state across runs (e.g. small windows show _negative_ Δ on a loaded host), which is
   the signature of emulator thermal/background drift rather than a feature cost. The definitive,
   device-independent evidence is the micro-benchmark: `snapshot()` costs **0.5–5.5 µs** even at
   a 30 s / 60-sample window, which cannot account for millisecond-scale swings on the observe
   call. The only real recurring cost the feature adds is the concurrent 500 ms `dumpsys` sampler
   competing for the device — inherent to the opt-in, and window-independent.

2. **5000 ms is the right default window — no change to `DEFAULT_PERF_WINDOW_MS`.** The
   decisive argument is device-independent sample arithmetic at the 500 ms host tier: a 5 s
   window holds ~10 samples — the smallest that yields a _genuine_ p50/p90/p95/p99 spread with a
   stable σ (≈0.3–0.5 on a clean host). Below it, 1000–2000 ms hold only 2–4 samples, so p95/p99
   collapse onto a single reading and σ is unreliable (0.3 → 17 depending on host load). Above
   it, 10 s/30 s are stable but over-smoothed — ~44 samples spanning ~22 s lag fast screen
   transitions — for no fidelity gain and marginally more compute.

3. **No perf fix required in the snapshot path.** Compute is µs-scale; `record()` is O(1)
   until the cap, where eviction shifts at most 512 retained samples. Optimizing the few
   O(n≤60) passes in `snapshot()` would trade readability for an unmeasurable gain (YAGNI).

### Caveat for very small windows

Windows near the 1000 ms clamp floor are only meaningful when a _denser_ sample source feeds
the buffer (e.g. a future on-device SDK FrameMetrics feed, #5076). At today's 500 ms host-side
tier they produce degenerate percentiles; the clamp floor is kept for that future source rather
than lowered further, and the default stays at 5000 ms.
