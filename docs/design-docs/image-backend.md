# Image backend: sharp primary + native cwebp on Windows

Status: accepted
Related: #2974 (Windows WebP daemon crash), #2920 (sharp→jimp migration), #2939 (screenshot cache format), #2424 (original sharp-under-Bun pin)

## Problem

The `@jimp/wasm-webp` WebP codec (adopted in #2920) runs on an Emscripten WASM
module that intermittently **segfaults the Bun process on Windows** via a
JSC Wasm JIT bug ([oven-sh/bun#26366](https://github.com/oven-sh/bun/issues/26366)).
A native segfault is uncatchable and kills the daemon mid-operation. The
navigation/plan features (`navigateTo`, `getNavigationGraph`, `executePlan`,
exploration) force WebP encode/decode and are the real runtime crash surface;
default PNG `observe`/screenshots are safe.

We want fast, reliable image processing with **WebP preserved on every
platform** and no WASM crash surface.

## Update (2026-07-31): sharp upgraded to 0.35.3, pin lifted

The freeze below rested on the claim that "sharp 0.35.x reintroduces the Bun
crash." That claim is **not reproducible** on any platform AutoMobile runs sharp
on. Using the standalone repro (`docs/reproductions/sharp-bun-035`, pinning
`sharp@0.35.3` / libvips 8.18.3) under Bun 1.3.14:

- **darwin/arm64** — passes (full WebP lossy/lossless/near-lossless + metadata).
- **linux/arm64** and **linux/amd64** (`oven/bun:1.3.14` containers) — pass. This
  closes the Linux gap the record previously left unverified.

The two "open crash" issues the freeze cited do not apply: [bun#20372](https://github.com/oven-sh/bun/issues/20372)
is a resource-starved fly.io _inpainting_ segfault (512 MB shared vCPU), not a
load/startup abort; [bun#29352](https://github.com/oven-sh/bun/issues/29352) is
**closed** and was a Bun _Windows path-handling_ bug unrelated to libvips — and
Windows never uses sharp (it routes to jimp + bundled cwebp). Staying on 0.34.5
also carried unpatched libvips CVEs (GHSA-f88m-g3jw-g9cj) fixed in 8.18.3.

**Change:** `sharp 0.34.5 → 0.35.3`, `@img/sharp-* → 0.35.3`,
`@img/sharp-libvips-* → 1.3.2`. The `.github/dependabot.yml` freeze `ignore`
block is replaced by a `groups` rule so the top-level `sharp` + every
`@img/sharp-*` binary bump together (the matrix must never split partially).
sharp 0.35 also moved its published types to ESM (`export default sharp`), so
`loadSharp.ts`'s `SharpFactory` now resolves the default export. The
macOS/Linux-only / Windows-non-sharp architecture below is otherwise unchanged.

## Root-cause context (corrected)

Primary-source research (sharp/libvips/Bun trackers, 2026-07) overturned the
premise carried in #2424/#2920:

- The "**jp2k/OpenJPEG init aborts Bun**" attribution is **unsupported**. The
  prebuilt `@img/sharp-libvips` binaries for both the working sharp 0.34.5 and
  the crashing 0.35.x are compiled with `-Dopenjpeg=disabled` (verified in
  `lovell/sharp-libvips` `build/lin.sh` + `build/mac.sh`, `libvips/meson_options.txt`).
  jp2k is not in the binary; no upstream issue attributes a Bun abort to it.
- sharp deliberately ships libvips as a _separate dynamically-linked shared
  library_ (kept separate for Apache-vs-LGPL licensing,
  [sharp#4023](https://github.com/lovell/sharp/issues/4023)). At the time this
  record was written we attributed the abort to a Bun N-API interop crash class
  against that separately-loaded lib and believed no released sharp/Bun version
  fixed it. **The 2026-07-31 update supersedes this**: 0.35.3 loads and runs
  cleanly under Bun on macOS and Linux, so whatever the original 0.35.0/0.35.1
  abort was, it does not affect the platforms AutoMobile runs sharp on.
  [bun#20372](https://github.com/oven-sh/bun/issues/20372) turned out to be a
  resource-starved fly.io _inpaint_ segfault, not a load-time abort.
- **sharp 0.34.5** (libvips 8.17.3 / `@img` 1.2.4) ran under Bun; **0.35.3**
  (libvips 8.18.3 / `@img` 1.3.2) now does too (see the update above). The
  original "0.35.x reintroduces the crash" claim is retracted.
- Windows still uses a non-sharp path (jimp + bundled cwebp) because
  global-libvips build-from-source is unsupported on Windows — not because of a
  Bun+sharp crash. ([bun#29352](https://github.com/oven-sh/bun/issues/29352),
  once cited here as a Windows Bun+sharp crash, was in fact a Bun Windows
  _path-handling_ bug unrelated to libvips, since closed.)
- `sharp-wasm32` is **not** a Windows option — it is a WASM build and would hit
  the same JSC-WASM-JIT crash class as `@jimp/wasm-webp`.

Conclusion: sharp covers macOS and Linux (0.35.3, validated under Bun — see the
2026-07-31 update above), and Windows takes a non-sharp, non-WASM path because
global-libvips build-from-source is unsupported there. (Originally this section
concluded that an all-platform sharp solution "needs an upstream Bun fix" and
pinned sharp to 0.34.5 on macOS/Linux; both conclusions are superseded — the pin
was lifted 2026-07-31.)

## Decision

- **macOS/Linux**: sharp **0.35.3** (was 0.34.5, pinned and frozen; pin lifted
  2026-07-31 — see the update note above).
- **Windows**: pure-JS **jimp** (resize/crop/PNG/pixels) + bundled native
  **cwebp/dwebp** for the WebP codec.
- **WebP is invariant across all platforms** — never downgraded to PNG.
- **Drop `@jimp/wasm-webp` entirely** — no code path uses jimp for WebP anymore,
  so the WASM crash surface (and the #2974 runtime crash + the CI flake) is
  removed from the whole project.

## Architecture: one backend interface, three implementations

The public `Image` API stays stable (as in #2920); the backend is swapped
behind it per platform. `ImageTransformer` records a declarative pipeline that
the active backend executes.

```ts
// src/utils/image/backend/ImageBackend.ts
export type ImageOperation =
  | {
      type: "resize";
      width: number;
      height?: number;
      maintainAspectRatio: boolean;
      mode?: "nearest";
    }
  | { type: "crop"; x: number; y: number; width: number; height: number };
export interface ImageEncoding {
  mime: "image/png" | "image/webp";
  options?: Record<string, unknown>;
}
export interface ImagePipeline {
  operations: ImageOperation[];
  encoding: ImageEncoding | null; // null = re-encode in the decoded input format
}
export interface RawImage {
  width: number;
  height: number;
  data: Buffer;
} // RGBA, length === w*h*4

export interface ImageBackend {
  execute(source: Buffer, pipeline: ImagePipeline): Promise<Buffer>;
  metadata(source: Buffer): Promise<ImageMetadata>;
  rawPixels(source: Buffer): Promise<RawImage>; // PerceptualHasher + pixelmatch
}
```

Implementations:

- **`SharpBackend`** (macOS/Linux default) — native chaining
  (`sharp(src).resize({fit})…webp({quality,lossless,nearLossless})/.png()`);
  `rawPixels` via `.ensureAlpha().raw().toBuffer({resolveWithObject})`.
- **`JimpCliBackend`** (Windows default) — jimp for decode/resize/crop/PNG/pixels;
  `CliWebpCodec` for the WebP leg (encode: jimp→PNG buffer→`cwebp`; decode:
  `dwebp`→PNG→jimp; magic-byte sniff to detect webp input).
- **`JimpBackend`** — pure jimp, no WebP — catchable-failure fallback on
  macOS/Linux if `import("sharp")` throws (module-discovery failure, which _is_
  catchable, unlike the native abort).

Selection (one injectable resolver, fake-able):

```ts
resolveImageBackend(options?: { platform?: NodeJS.Platform; sharpLoader?: SharpLoader }): ImageBackend
// win32 → JimpCliBackend
// darwin/linux → SharpBackend, falling back to JimpBackend if sharp import throws
// other → JimpBackend
```

## Seam — existing code changes

- `ImageTransformer.ts`: `resize()/crop()/png()/webp()` record into
  `ImagePipeline`; `toBuffer()` → `backend.execute(buffer, pipeline)`;
  `getMetadata()` → `backend.metadata()`. `ImageCache` unchanged (backend-agnostic).
- `PerceptualHasher.ts` → `backend.rawPixels()` then existing 8×8 greyscale/red-channel.
- `ScreenshotComparator.ts` → `backend.execute(buf, {output:"png"})` for
  conversion, `backend.metadata()` for dims (keep PNG-IHDR fast path),
  `backend.rawPixels()` ×2 for `pixelmatch`.
- `ContrastChecker.ts` → `backend.rawPixels()`.
- `image-utils.ts` → backend-agnostic `ImageUtils`.
- Call sites in `NavigationScreenshotManager` / `TakeScreenshot` are untouched
  (they use the stable `Image` API).

## cwebp/dwebp: bundled, never absent

WebP must never be absent on Windows, so binaries are **bundled**, not
downloaded on demand (download has an offline gap that only PNG could fill —
which we reject).

- Ship Windows `cwebp.exe`/`dwebp.exe` (libwebp, ~1 MB) in the package under
  `vendor/libwebp/win32-x64/`. Always present, offline or not (+~1 MB unpacked,
  well under the 30 MB gate).
- Resolution order: `AUTOMOBILE_CWEBP_PATH`/`AUTOMOBILE_DWEBP_PATH` → `PATH` →
  bundled copy.
- Invoke via `ProcessExecutor` with stdin/stdout piping (`cwebp -o - -- -`,
  `dwebp -o - -- -`). Flag mapping: `{quality}`→`-q`, `{lossless}`→`-lossless -q`,
  `{nearLossless}`→`-near_lossless <quality>` (cwebp's `-near_lossless` requires a
  numeric preprocessing level; the current API models `nearLossless` as a boolean
  and uses `quality` as that level — mirror it, do not emit a bare `-near_lossless`).
- **Failure is a surfaced error, never PNG**: a cwebp/dwebp spawn/exit failure
  throws `ActionableError` (CLAUDE.md strategy 1) pointing at
  `AUTOMOBILE_CWEBP_PATH`. On-disk format stays uniformly `.webp` everywhere.
- A macOS `cwebp` build for exercising the `JimpCliBackend` WebP path off-platform
  (dev-only) stays download-on-demand — no offline guarantee needed there.

## Dependency & build management — the anti-treadmill work

Pinning the sharp matrix coherently is part of the deliverable (this is what
#2920 lacked):

- `package.json`: `sharp@0.35.3` + the `@img/*` optionalDependencies pinned to
  `0.35.3` (`@img/sharp-libvips-*` at `1.3.2`). Keep `jimp`/`@jimp/core`. Remove
  `@jimp/wasm-webp`. (Originally `0.34.5`/`1.2.4`; bumped 2026-07-31 — see the
  update note above.)
- **Dependabot `groups`** rule keying `sharp` + every `@img/sharp-*` together, so
  the native matrix always bumps in a single PR and can never split partially.
  (This replaced the original freeze `ignore` block once 0.35.3 was validated
  under Bun on macOS + Linux.)
- `build.ts` externals: add `sharp` + `@img/sharp-*` back (external + lazy, as
  the old `loadSharp.ts` did); keep `jimp`/`@jimp/*` external.
- Re-check the NPM-unpacked-size benchmark (30 MB threshold; ~14 MB today).

## Biggest correctness risk — cross-backend pixel divergence

`PerceptualHasher` and `pixelmatch` operate on decoded pixels, and sharp's
resize kernel ≠ jimp's:

- pHash values change again on macOS/Linux (jimp→sharp), and Windows (jimp)
  produces different hashes than macOS/Linux (sharp) for the same screenshot →
  **nav-screenshot caches are per-machine and are not portable across platforms**.
  Within one machine it is self-consistent (one backend), matching still works,
  and nav caches are local — this is the accepted cache contract (ties to #2939).
- WebP format is now uniform across platforms (bundled cwebp, no PNG downgrade),
  so the only cross-platform difference is the resize-kernel pixel delta, not a
  format mismatch.
- Tests: migrate `PerceptualHasher`/comparator golden-string assertions to
  backend-relative assertions (similarity of A vs A′, distinctness of A vs B) or
  per-backend goldens via `FakeImageBackend`.

## Testing (interface + fake, <100 ms, no real native/subprocess in unit tests)

- `FakeImageBackend` (`test/fakes/`) — canned buffers + `rawPixels`; transformer/
  hasher/comparator/contrast tests run with no sharp, no jimp, no subprocess.
- Reuse `FakeProcessExecutor` + `FakeFileDownloader` for `CliWebpCodec` +
  provisioner unit tests (argv, resolution order, magic-byte sniff, error path).
- Real-lib coverage in the smoke harness, platform-gated: recover
  `sharp-runtime-smoke.ts` for macOS/Linux CI; add a `jimp+cwebp` smoke for
  Windows CI; keep the WebP roundtrip + 3-mode-distinctness checks.

## doctor + observability

`doctor` includes a log-then-return-typed-failure check (CLAUDE.md strategy 2)
reporting: active backend, sharp load status (macOS/Linux), and cwebp/dwebp
resolution (Windows).

## Phasing

1. **Backend seam + `FakeImageBackend`** — introduce `ImageBackend`, refactor
   `ImageTransformer`/consumers, no behavior change (JimpBackend only). Green tests.
2. **SharpBackend + deps** — pinned sharp/`@img`, dependabot ignores, build
   externals, selection resolver (sharp on macOS/Linux), recover sharp smoke,
   migrate hash tests. `@jimp/wasm-webp` is **kept** here — Windows/fallback still
   needs it until cwebp lands.
3. **JimpCliBackend + bundled cwebp** — libwebp bundling/spawn, Windows
   selection, Windows smoke, surfaced-error path. **Only now** drop
   `@jimp/wasm-webp`: with sharp covering macOS/Linux and cwebp covering Windows,
   no code path uses jimp for WebP, so removing it can't leave any path without a
   codec. (The wasm removal and cwebp introduction must land together — never
   drop the plugin before cwebp exists.)
4. **doctor check + docs** — cache-portability contract, close #2974.

## Contribution track (non-blocking) — resolved

This section originally proposed building a minimal repro of the
"0.35.x-under-Bun abort" to attach to
[bun#20372](https://github.com/oven-sh/bun/issues/20372)/[bun#29352](https://github.com/oven-sh/bun/issues/29352)
(cf. [sharp#4042](https://github.com/lovell/sharp/issues/4042)), and to unfreeze
sharp once Bun fixed the interop. **That work is done and its premise did not
hold**: the repro (`docs/reproductions/sharp-bun-035`) shows 0.35.3 loading and
running cleanly under Bun on macOS and Linux, so there is no abort to report
upstream and no Bun fix to wait for. sharp was unfrozen to 0.35.3 on 2026-07-31.
Windows stays on jimp + cwebp for the global-libvips reason above, not a Bun bug.

### Issue #3014 upstream repro record

The standalone repro lives in `docs/reproductions/sharp-bun-035`. It pins
`sharp@0.35.3`, imports no AutoMobile code, creates a tiny PNG through sharp,
exercises lossy/lossless/near-lossless WebP encodes, and reads WebP metadata.
Capture local output under `scratch/sharp-bun-0.35-repro/` before posting
evidence upstream.
Use `bash scripts/validate-sharp-bun-repro.sh` to run the standalone harness in
an isolated scratch copy and verify the live output shape.

Local issue #3014 capture on 2026-07-07: `darwin arm64`, Bun `1.3.14`,
sharp `0.35.3`, and libvips `8.18.3` passed the standalone repro. A Linux
container attempt could not run because the Docker daemon was unavailable, so
the recorded evidence is a minimal sharp 0.35.x interop repro package plus a
macOS pass result, not a Linux/Windows crash log.
