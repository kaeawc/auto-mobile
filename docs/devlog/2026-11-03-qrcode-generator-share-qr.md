# qrcode-generator for the prototype share QR

- Kind: decision
- Date: 2026-11-03
- Source: moved from `docs/decisions/qrcode-generator-share-qr.md` (added in #16496)

Status: accepted for #14128 (MCP `prototype share` returns a QR of the ProtoViewer import link).

Dependency: `qrcode-generator`

## Decision

`prototype share` encodes `automobile-proto://import?url=…&sha256=…` as a QR code: a PNG for the
screen or a slide, and a block-character rendering for the terminal. The QR grid comes from
`qrcode-generator` (MIT, no dependencies, ships its own types), pinned to an exact version as a
devDependency that the build bundles, like `pngjs`. Only `addData`, `make`, `getModuleCount` and
`isDark` are used. The PNG is written with `pngjs`, which is already a direct dependency, and the
terminal rendering is a few lines in `protoViewerShareQr.ts`. A unit test checks the finder patterns
and the quiet zone, and the encoded link was decoded with an independent reader (OpenCV) while the
change was written.

## Alternatives checked

| Alternative                             | Why not                                                                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime standard library (Node, Bun)    | Neither has a QR encoder.                                                                                                                      |
| Existing dependencies (`sharp`, `jimp`) | They draw images but do not encode QR codes.                                                                                                   |
| A hand-written encoder in `src/`        | Reed–Solomon, per-version block tables, masking and penalty scoring add several hundred lines of code that would need their own decoder tests. |
| `qrcode` (soldair)                      | Larger, with runtime dependencies (`pngjs`, `dijkstrajs`, `yargs`) that would enter the bundle.                                                |
