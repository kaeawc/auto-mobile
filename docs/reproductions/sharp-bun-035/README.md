# sharp 0.35.x Bun repro

Minimal standalone reproduction for AutoMobile issue
[#3014](https://github.com/kaeawc/auto-mobile/issues/3014). It intentionally
has no AutoMobile dependencies and pins `sharp@0.35.3`, the sharp 0.35.x line
called out in the image-backend design record.

Upstream tracking:

- [oven-sh/bun#20372](https://github.com/oven-sh/bun/issues/20372)
- [oven-sh/bun#29352](https://github.com/oven-sh/bun/issues/29352)
- [lovell/sharp#4042](https://github.com/lovell/sharp/issues/4042)

Run from this directory:

```bash
bun install
bun run repro
```

The script imports sharp, prints Bun/platform/sharp runtime versions, creates a
small PNG entirely through sharp, exercises lossy/lossless/near-lossless WebP
encodes, reads WebP metadata, and prints `ok` if the process survives.

To validate the full behavior without mutating this directory, run the repo
helper from the root:

```bash
bash scripts/validate-sharp-bun-repro.sh
```

The helper copies this standalone package into `scratch/`, installs with the
checked-in lockfile, runs `bun run repro`, and asserts sharp `0.35.3`, WebP
metadata, nonzero lossy/lossless/near-lossless outputs, and the final `ok`
marker.

Local result captured for issue #3014 on 2026-07-07:

- `darwin arm64`, Bun `1.3.14`, sharp `0.35.3`, libvips `8.18.3`: passed;
  output is in `scratch/sharp-bun-0.35-repro/local-output.txt`.
- Linux container check was not exercised because the local Docker daemon was
  unavailable; attempted output is in
  `scratch/sharp-bun-0.35-repro/linux-container-output.txt`.

For issue #3014 validation, capture output from the repo root:

```bash
mkdir -p scratch/sharp-bun-0.35-repro
(
  cd docs/reproductions/sharp-bun-035
  bun install
  bun run repro
) > scratch/sharp-bun-0.35-repro/local-output.txt 2>&1
```

Optional Linux container check:

```bash
docker run --rm \
  -v "$PWD/docs/reproductions/sharp-bun-035:/repro" \
  -w /repro \
  oven/bun:1.3.14 \
  sh -lc 'bun install && bun run repro' \
  > scratch/sharp-bun-0.35-repro/linux-container-output.txt 2>&1
```
