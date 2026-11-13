# Prototype performance measurements

- Kind: decision
- Date: 2026-10-13
- Source: moved from `how-it-works/plat/android/prototype-performance-measurement.md`; #12139, #12187, #12345, #15562
- Shaped: [Prototype performance measurement](../how-it-works/plat/android/prototype-performance-measurement.md)

## Context

When the frame-time benchmark landed (#12187) no device baseline was recorded. #12139 asked whether
the up-front composition of a vertical `scroll` costs enough to justify deferring off-screen rows
behind same-size placeholders.

## Options

- Keep composing every child up front (`Box(verticalScroll)`).
- Defer off-screen rows behind same-size placeholders.
- A `LazyColumn`.

## Decision

The owner decision is to keep every row findable: no `LazyColumn`. Any deferral waits for the
on-device figure for the benchmark list (`scripts/android/prototype-frame-benchmark.sh --scenario
scroll`), which was still owed.

## Consequences

### First-show measurement (#12345)

`PrototypeScrollMeasurementTest` under Robolectric, setContent through `waitForIdle`. Two runs, medians:

| Scenario                                     | Render nodes | Semantics nodes | Median ms | p90 ms    |
| -------------------------------------------- | ------------ | --------------- | --------- | --------- |
| trivial column (fixed overhead)              | 2            | 3               | 6.4-7.6   | 7.7-9.6   |
| 87 rows (largest measured prototype)         | 176          | 90              | 4.1-4.9   | 4.4-8.0   |
| benchmark list (`benchmark/prototype-frame`) | 335          | 183             | 7.7-7.9   | 12.5-17.4 |
| 200 rows                                     | 402          | 203             | 4.5-5.0   | 5.7       |
| 500 rows                                     | 1002         | 503             | 17.6-17.9 | 31.9-35.8 |

Scenarios run in JUnit's method-name-hash order (trivial, 500, benchmark list, 87, 200), not
the order above. The first two therefore carry more JIT/GC warm-up than the last two, and the trivial
case reads slower than 87 rows for that reason. The numbers exclude spec-to-render-model mapping
(the runtime's cached render model is reused) and draw. Cost is not linear in rows. Going from 87 to 200
rows adds under 1 ms. Going from 200 to 500 rows adds roughly 13 ms (about 42-45 us per row, inflated by the
500-row case running early), and only 500 rows reaches a median of about 18 ms. Every row text is
present in the semantics tree in every scenario (asserted). Robolectric numbers are not device frame times.
The on-device figure for the benchmark list (`scripts/android/prototype-frame-benchmark.sh
--scenario scroll`) is still owed before any deferral is built.

### Feed baseline

The feed baseline ran on 2026-10-26 with 1,000 rows, debug CtrlProxy on an API 37 arm64 emulator with
software rendering, and a host load average above 140. Results: `feed-scroll-down` p95 250 ms and
`feed-fling-roundtrip` p95 300 ms (about 98% janky), `feed-idle` no frames. This is a
smoke baseline, not a verdict: it misses the 16 ms target, but the debug build, software
GL and a saturated host dominate it. Re-measure a release build on an idle host or device.
iOS simulator (iPhone 17, iOS 26.5): six scripted swipes took 50.5 s wall time including
CLI overhead, which is not a frame-time measure.
