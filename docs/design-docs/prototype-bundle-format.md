# Prototype bundle format v1 and shared rejection corpus

Issue #13616, slice 1. TypeScript implementation: `src/features/prototype/bundle/`.
This is a filesystem-free in-memory transport. Android/iOS store manifests and their
metadata remain unchanged. Importer slices must translate the transport manifest,
write into an owned staging directory using `O_NOFOLLOW` and `lstat`, and atomically
commit on the same filesystem; this module creates no directories or files.

## Manifest and API

`bundle.json` is a strict JSON object with exactly these required fields:

```json
{
  "bundleFormatVersion": 1,
  "specSha256": "64 lowercase hexadecimal characters",
  "assets": [
    {
      "id": "opaque-spec-id",
      "file": "assets/<sha256>.png",
      "sha256": "<sha256>",
      "mediaType": "image/png"
    }
  ],
  "fonts": [],
  "requires": []
}
```

Assets use png/jpg/webp with image/png, image/jpeg, image/webp; fonts use ttf/otf
with font/ttf, font/otf. `file` must equal the SHA-derived path for its media type.
IDs obey the existing asset-ID contract, are unique across both lists, and every
ID must be referenced by the validated, expanded executable spec. Multiple IDs may
share the same file. At most 32 manifest records total. `requires` is a unique list
of at most 32 advisory capability identifiers, each matching `[a-z][a-z0-9_]{0,127}`.
Unknown capabilities are preserved; the consuming platform decides support.

`readPrototypeBundle(bytes, limits?)` returns `{manifest, specJson, assets, fonts}`;
asset/font maps are keyed by SHA-256. Failure throws `PrototypeBundleError`, an
`ActionableError` with closed `code`, optional `entry`, and `message`. Missing spec
references use their opaque ID as `entry`; missing files use their filename.
No filesystem, DNS, network, clock, randomness, or logger is used by the codec.
The reused spec validator may log invalid JSON; the codec decodes JSON itself
before validation so malformed JSON is a structured codec failure.

`exportCanonicalBundle({spec, assets?, fonts?, requires?})` takes existing
`PrototypeAssetUpload` records (id, mimeType, bytes). It validates the spec and
rebuilds an archive containing only referenced uploads, plus bundle.json/spec.json.
It strips top-level local-envelope keys storage, library, source, sourceUrl, label,
lastOpenedAt, thumbnail. Other unknown fields are refused by the existing spec
validator. Authored state/data and opaque JSON are retained: they are prototype
content, not a local store snapshot. Callers must pass the authored spec rather
than substituting runtime stored values into it. Readers refuse a spec containing
storage policy. Platform store manifests must never be zipped directly.

JSON uses the existing `src/utils/stableStringify.ts`: recursive key sorting and
ECMAScript JSON serialization. Integer-index keys serialize first in ascending
numeric order, other keys in UTF-16 code unit order. Arrays retain their order.
Manifest records (by ID), requires, and ZIP entry names use code unit ordering
(ZIP filenames are ASCII). ZIP uses STORED only, version 20, flags zero, fixed DOS 1980-01-01
00:00:00, zero external attributes, and no extra fields/comments/descriptors.
STORED avoids deflater-version differences and guarantees the export ratio fits.
No source URL, thumbnail, library file, local storage policy, or timestamps are
added. Repeated exports of equivalent input produce identical bytes.

`preflightBundleSecrets(spec)` returns advisory `{code,path,name}` warnings for
secret_header (Authorization/Cookie/X-Api-Key, case insensitive), secret_query
(token/key/secret/sig, case insensitive, URL and explicit query keys), private_host
(localhost/subdomains and non-public IP literals). It reuses the egress address
classifier and component/node/action walkers, including nested request follow-ups.
It performs no DNS lookup; domain names resolving to private addresses cannot be
classified offline. Diagnostic names never contain header/query secret values.

## Resource limits

All archive caps are named in `bundleLimits.ts`, derived from
`schemas/prototype-asset-contract.json`. Limits supplied by callers can only be
positive safe integers tightening these defaults. Invalid/raised limits fail.

| Constant                    |      Value | Derivation                                                   |
| --------------------------- | ---------: | ------------------------------------------------------------ |
| MAX_BUNDLE_ENTRIES          |         36 | asset count 32 + two metadata entries + two reserved slots   |
| MAX_BUNDLE_MANIFEST_BYTES   |     65,536 | font cap 2,097,152 / asset count 32                          |
| MAX_BUNDLE_SPEC_BYTES       |  1,048,576 | min(existing spec-contract cap, image cap / 4)               |
| MAX_BUNDLE_EXPANDED_BYTES   | 17,891,328 | asset total 16,777,216 + spec allowance + manifest allowance |
| MAX_BUNDLE_COMPRESSED_BYTES | 17,899,558 | expanded cap + 36 × (30 + 46 + 2 × 76) + 22                  |
| MAX_BUNDLE_RATIO            |         64 | asset count 32 × (image cap 4,194,304 / font cap 2,097,152)  |

The compressed cap is the entire input archive, including all headers. The
expanded cap is cumulative actual output; individual images retain the 4 MiB cap,
fonts 2 MiB, assets/fonts together 16 MiB. The per-entry ratio is actual expanded
bytes / compressed payload bytes (zero compressed bytes permit zero output only).
Spec and manifest have the allowances above. `maxOutputLength` in zlib counts
output while inflating; headers never authorize unbounded allocation. The remaining
aggregate budget and ratio budget further tighten that hard cap. Header-declared
sizes are checked before inflate and actual sizes/CRC after inflate. A cap hit
reports the smaller limiting budget (expanded wins a tie). Exact boundaries pass.
The expanded/spec allowances reserve metadata independently of the asset total;
manifest record count makes normally realizable archives at most 34 entries.

## ZIP acceptance and rejection ordering

ZIP32 central-directory and local headers must agree on name, flags, version,
method, CRC and sizes. Input must consist of contiguous local entries starting at
byte zero, followed immediately by the complete central directory and a 22-byte
EOCD. No gaps, overlaps, preambles, EOCD comments, entry comments or trailing data.
Well-formed non-ZIP64 extra fields are accepted (and removed on export).
STORED and raw DEFLATE only; a DEFLATE stream must consume its entire payload.
Only flags zero or UTF-8 (bit 11) are allowed; all accepted names are ASCII anyway.
Data descriptors are refused, including otherwise-verifiable descriptors. ZIP64
markers, ZIP64 extra fields, version-needed >=45, and multi-disk fields are refused.
Unix attributes are allowed only with a regular-file type (or a completely zero
mode); permission-only modes, symlinks and special types fail regardless of creator
OS. DOS directory attributes fail. This conservative subset is shared by all readers.

Names allow exactly bundle.json, spec.json, assets/[0-9a-f]{64}.(png|jpg|webp),
fonts/[0-9a-f]{64}.(ttf|otf). Names with non-ASCII bytes fail before path checks;
ASCII names with `..`, backslash, leading slash, drive prefix or NUL fail as path
traversal. Remaining disallowed names (including directories and __MACOSX) fail
entry_not_allowed. Duplicate names are case sensitive and fail before inflation.

Processing order: validate overrides and input compressed cap; locate/validate
EOCD and count; parse central entries in directory order (name, attributes/disk/
ZIP64/flags/method, extras, duplicates); process local entries by ascending offset;
check local header consistency, expanded cap, ratio, inflate, actual size, CRC;
require/parse manifest, require/hash/decode/validate spec, reject storage; reject
unlisted files and asset-total excess; cross-check image IDs/files/SHA/payload,
then font IDs/files/SHA/payload. First failure wins. Kotlin and Swift must mirror
this order as well as the codes, not rely on platform ZIP-library error messages.
The transport hashes encoded files; image decoding belongs to later importers.
Font signatures reuse the existing asset contract's TTF/OTF detection.
The detected signature must match the declared font media type.

| Code                  | Meaning                                                            |
| --------------------- | ------------------------------------------------------------------ |
| entry_not_allowed     | Non-allowlisted entry, DOS directory, or unlisted payload          |
| duplicate_entry       | Repeated central-directory filename                                |
| path_traversal        | Unsafe ASCII path spelling                                         |
| non_ascii_name        | Filename contains a byte above 127                                 |
| unsupported_method    | Compression method other than 0 or 8                               |
| encrypted             | Encryption, strong-encryption or masked-header flag                |
| unix_mode_not_regular | Nonzero Unix mode without regular-file type                        |
| multi_disk            | Archive/entry disk fields or EOCD counts disagree                  |
| too_many_entries      | EOCD entry count exceeds cap                                       |
| compressed_too_large  | Whole archive exceeds compressed cap                               |
| expanded_too_large    | Individual, aggregate or asset-total expanded cap                  |
| ratio_exceeded        | Declared or actual entry ratio exceeds cap                         |
| size_mismatch         | Local/central mismatch or actual/header size mismatch              |
| crc_mismatch          | Inflated CRC-32 differs                                            |
| sha_mismatch          | Spec hash or manifest/named payload hash differs                   |
| eocd_invalid          | Missing/truncated EOCD or inconsistent directory extent            |
| manifest_invalid      | Invalid JSON/UTF-8/schema/group/path/ID/reference/payload contract |
| spec_invalid          | Invalid JSON/UTF-8/spec contract or storage present                |
| missing_entry         | Required file or referenced ID absent                              |
| extra_data            | Gaps, overlaps, comments, trailing data, leftover DEFLATE input    |
| zip64_unsupported     | ZIP64 marker/extra/version-needed                                  |
| flags_unsupported     | Unsupported flags, including data descriptors                      |
| zip_invalid           | Invalid/truncated header, bounds or extra-field structure          |
| inflate_invalid       | Malformed DEFLATE or unavailable inflate-result accounting         |
| limits_invalid        | Noninteger, nonpositive or raised cap override                     |

## Language-neutral recipe format

Fixtures live in `test/fixtures/prototype-bundle/{valid,invalid}/*.json`, pinned to
LF as text in .gitattributes. No binary ZIPs are checked in. The independent test
builder is `test/helpers/prototypeBundleRecipe.ts`; Kotlin/Swift must implement the
same JSON recipe instructions. The corpus test verifies every closed code occurs.

Each recipe has `description`, optional `base`, optional `limits` (the four
BundleLimits field names), and `expected`: either `"accept"` or `{code,entry?}`.
`base: "minimal"` creates bundle.json and spec.json in that order. The default spec
is compact UTF-8 JSON with exactly this insertion order:

```json
{
  "id": "minimal",
  "window": { "placement": { "type": "fullscreen" } },
  "root": { "type": "text", "text": "Hello" }
}
```

`base: "assets_fonts"` replaces root with column/children, first image asset
`"image"`, then text `"Font"` styled with fontFamily `{asset:"font"}`. It adds
image bytes [1,2,3] as image/png and font bytes [0,1,0,0] as font/ttf. Image/font
records have id,file,sha256,mediaType in that order. The manifest field order is
bundleFormatVersion,specSha256,assets,fonts,requires. The hash covers the exact
compact spec bytes. All defaults use STORED. No base means no implicit entries.
`spec` replaces the base spec. `manifest` shallow-overrides base manifest fields.
Serialize JSON compactly, no newline, in the order shown/authored in the recipe.

`omit` removes base entries by literal filename. `overrides` shallow-merges entry
fields by name after omission; `entries` appends entries (including duplicates).
An entry has `name` plus optional:

- `text`: UTF-8 content; defaults to empty.
- `base64`: decoded content, takes precedence over text.
- `repeat: {byte,count}`: generate count copies of one byte, takes precedence over both.
- `method`: ZIP method integer, default 0; method 8 raw-deflates at level 6.
- `rawBase64`: exact compressed payload overriding the compressed/generated bytes.
- `flags`, `attrs`: flags and unsigned external attributes; defaults zero.
- `compressedSize`, `expandedSize`, `crc`: override BOTH local and central header
  values. Otherwise actual payload size, original content size, CRC-32(original).
- `extraBase64`: extra fields put identically into local and central headers.

Names `$image` and `$font` (including in expected.entry) expand to the base
SHA-derived filenames. Other names are literal UTF-8, including NUL. Local header
version-needed is 20, all unmentioned fields zero; central creator is Unix version
20 (0x0314). Central records follow local-entry order with their actual offsets.
EOCD disks zero, counts entry count, extent actual central-directory extent.

`patches` run sequentially after construction. Each is
`{region,index?,offset,type,value}`: region local/central selects that entry's
header start (index defaults zero), eocd selects EOCD start, absolute selects byte
zero. Offset is byte offset relative to that start. Type u16/u32 writes unsigned
little-endian numeric value; base64 copies decoded string bytes. Patches do not
recompute CRCs, offsets or lengths. `trailingBase64` appends literal bytes after
EOCD; then `truncate` removes that many bytes from the end. Region positions are
calculated before trailing bytes/truncation. Bomb recipes use tiny configured
budgets; the real-cap tests use bounded STORED generation instead of expensive
compression. DEFLATE recipes' generated byte count and raw payload can be mirrored
with each platform's standard zlib implementation; acceptance does not depend on
byte-identical compression outputs (except explicit rawBase64).

Cross-platform staging, atomic import, capability UX and actual Android-to-iOS /
iOS-to-Android round trips remain acceptance work for later platform slices.
