# ScreenCaptureCore benchmarks

Micro-benchmarks for the per-frame byte transforms on the screen-capture hot path —
the pure, device-free `ScreenCaptureCore` layer where the encoded path's copies live.
They quantify the allocation/CPU cost that the Swift-6 + performance pass targets.

This is a **separate** SwiftPM package (its own `Package.swift`) so the shipped
`screen-capture` package never depends on [`ordo-one/benchmark`][pb] or its
jemalloc/pkg-config system requirement. `scripts/ios/swift-build.sh` builds only the
shipped package, so CI is unaffected and these run on demand, locally.

## Running

```bash
# One-time system prerequisites for package-benchmark's allocation metrics:
brew install jemalloc pkg-config

# Run all benchmarks:
swift package --package-path ios/screen-capture/Benchmarks --disable-sandbox \
  --allow-writing-to-package-directory benchmark

# Capture a baseline and compare a later run against it (how the numbers below
# were produced):
swift package --package-path ios/screen-capture/Benchmarks --disable-sandbox \
  --allow-writing-to-package-directory benchmark baseline update before
# ...make changes...
swift package --package-path ios/screen-capture/Benchmarks --disable-sandbox \
  --allow-writing-to-package-directory benchmark baseline compare before
```

`Malloc (total)` (heap allocations per call, via jemalloc) is the headline metric —
it directly shows the per-frame copy/alloc reduction.

## Before / after (this pass)

Measured on Apple silicon, Swift 6.3.3, release build, p50 of 100k iterations.
"before" = the pre-optimization converter/header; "after" = this pass.

| Benchmark | Malloc (total) | Time (total CPU) |
| --- | --- | --- |
| `assembleAccessUnit` — delta frame | 4 → **2** | 2709 → **2083** ns (−23%) |
| `assembleAccessUnit` — keyframe + SPS/PPS | 9 → **2** (−78%) | 4542 → **2416** ns (−47%) |
| `encodeEncodedVideoHeader` (per-frame header) | 4 → **2** | 1666 → **1458** ns (−12%) |
| encoder copy-out: `Data(bytes:)` + assemble | 6 → 4 | 3417 → 2750 ns |
| encoder copy-out: `Data(bytesNoCopy:)` + assemble | 5 → **3** | 2834 → **1958** ns |
| `encodeFloat32LE` (audio, unchanged control) | 2 → 2 | ~1750 ns |

The last two rows isolate **copy #1** (the encoder's copy-out of the VideoToolbox
`CMBlockBuffer`), which the real device path now elides with `Data(bytesNoCopy:)`:
within the same build, `bytesNoCopy` + assemble is one fewer allocation and ~29% less
CPU than `Data(bytes:)` + assemble.

## Raw path (pooled vs unpooled)

The raw BGRA path copies an entire uncompressed frame (~8.3 MB at 1080p) per frame —
the largest per-frame slab in the system. The copy off the locked `CVPixelBuffer` is
unavoidable; `FrameBufferPool` only removes the fresh-slab allocation and its
first-touch page faults, so both variants share the same memcpy floor (the ~100 µs `p0`).

| 1080p BGRA frame copy (~8.3 MB) | Time (total CPU) p50 | Throughput |
| --- | --- | --- |
| `Data(bytes:)` (unpooled) | 166 µs | 6.0 K/s |
| `FrameBufferPool` (pooled) | **126 µs** (−24%) | **8.1 K/s** |

At ~126 µs the raw copy is roughly **60× the compressed access-unit assembly** — this is
where per-frame copy cost actually lives — yet still only ~0.4% of a core at 30 fps for
the *in-helper* copy alone. The genuinely expensive raw-path costs are cross-process and
not captured here: piping 8 MB/frame through the pipe to Node plus a separate ffmpeg
re-encode. That is why the encoded path is the default.

## Interpretation (honest scope)

These are real, directionally-clear reductions — the keyframe access unit drops from
nine heap allocations to two. **But** they run on *compressed* buffers (tens–hundreds
of KB), so the absolute cost is only a few microseconds per frame — a fraction of a
percent of one core at 60 fps. This pass therefore **rules out** in-helper byte-copying
as a driver of the production CPU spikes on the encoded path; the dominant costs remain
VideoToolbox encoding itself (especially the `-allow_sw` software fallback on shared
runners) and, on the *raw* fallback path, the ~8 MB/frame BGRA copy plus a separate
ffmpeg re-encode. The wins here are allocation hygiene and a cleaner, less GC-churny
hot path, not a CPU-spike fix by themselves.

[pb]: https://github.com/ordo-one/benchmark
