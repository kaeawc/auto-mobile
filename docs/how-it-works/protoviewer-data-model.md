# ProtoViewer: data model and import validation

Part of [ProtoViewer](protoviewer.md).

## 4. Data model and formats

**The store layout stays untouched.** Per-platform manifests (`manifest.json`, formatVersion 1) do
not change: Android's reader requires `id`, `label`, `savedAt` and rejects unknown keys; iOS requires
exactly `formatVersion`, `specFile`, `assets` and `fonts`. Library metadata lives in a sibling
`library.json` next to the manifest (iOS: per prototype directory; Android: alongside the slug
directory or one index file):

```json
{
  "libraryId": "<uuid, app-generated>",
  "label": "...",
  "importedAt": 0,
  "lastOpenedAt": 0,
  "source": "mcp|file|share|paste",
  "specSha256": "...",
  "requires": ["prototype_data_model_v1"],
  "pinned": false,
  "sourceHost": "proto.example.com"
}
```

`source`, `sourceHost` and trust are app-owned: the importing code path writes them from how the bytes arrived,
and they are never read from bundle bytes. The file is never part of an export. A corrupt or
unreadable `library.json` entry is skipped, not fatal.

**Bundle (share and import) format**, separate from the store manifests (#13616). `*.automobile-proto`
is a zip, MIME `application/vnd.automobile.prototype+zip`, iOS UTI
`dev.jasonpearson.automobile.prototype`. The strict zip reader accepts exactly:

- Entries: `bundle.json`, `spec.json`, `assets/[0-9a-f]{64}\.(png|jpg|webp)` and
  `fonts/[0-9a-f]{64}\.(ttf|otf)`. It rejects directories, parent-relative or absolute paths,
  backslashes, NUL, non-ASCII names, `__MACOSX` and duplicate names. It also rejects symlink or
  nonregular Unix file-type attributes, encrypted entries, compression methods other than STORED
  and DEFLATE, and multi-disk archives.
- `bundle.json`: `{ "bundleFormatVersion": 1, "specSha256": "...", "assets": [{id,file,sha256,mediaType}], "fonts": [...], "requires": [capabilities] }`.
  Strict; no label, source or storage. Each platform's importer translates it into its own store
  layout.
- The reader streams, counts inflated bytes rather than trusting header sizes, and allows at most
  36 entries. It applies the per-file caps from `schemas/prototype-asset-contract.json`, one
  compressed cap and one expanded cap derived from the contract, and a ratio cap. It verifies
  sha256 after inflating, stages in a fresh directory and commits atomically.
- A bare spec (`*.json`, `application/json`, at most 1 MiB, no assets) is also accepted.
- **Export rebuilds a canonical bundle** from `spec.json` plus only the assets the spec references:
  never storage, `library.json`, a source URL or last-opened time. A preflight scan warns before
  share about credential-like headers and query keys and private or loopback hosts. There are no
  thumbnails.
- Importing a prototype whose `spec.id` already exists creates a new entry with its own library id
  and empty storage. On iOS, a matching spec SHA-256 plus identical image and font resource IDs,
  media types and byte SHA-256 values instead reuses the existing entry, preserving its label,
  provenance and storage. Unreadable candidates are skipped. There is no replace or keep-both.
- Android accepts `automobile-proto://import?url=…&sha256=…` links after confirming the host and
  hash, fetching through the egress policy and verifying the downloaded bytes. Universal links and
  compact `?spec=` links remain unsupported. The internal scheme `automobile-proto://` also remains
  for legacy callers (section 7): it imports a host-staged inbox bundle or opens an existing library
  entry. Simulator hosts use the file inbox instead. The scheme never carries spec bytes.
- Link sharing (#14128) uses a team-supplied static https host; there is no AutoMobile relay and no
  LAN serving from the daemon. MCP `prototype share` writes the canonical bundle under the data
  directory and, given the https `url` it will be served from, returns
  `automobile-proto://import?url=<percent-encoded>&sha256=<bundle hex>` and its QR (byte mode, level
  M, link at most 1024 bytes). The hash pins the exact bytes: the importer must show host and hash,
  fetch with the egress check, and refuse a mismatch before the strict import path, with
  `source: "share"`. Links do not expire. Android only; iOS distribution beyond dev-signed builds is
  out of scope.

**Report, hide and block** (App Store 1.2, Play UGC). They apply only to received content
(`source` `file` or `share`); the user's own `mcp` and `paste` prototypes are never hidden.
Android implements them; the iOS viewer does not yet (#16437).

- Identity: Block uses the link-origin host, the lowercase DNS host a link import (#14128) fetched
  the bundle from, recorded in `library.json` as `sourceHost` (null for every other source). The
  bundle carries no author field, because a self-asserted author would be spoofable. A file or
  share-sheet import has no sender identity, so it offers Hide and Report but not Block.
- Hide stores the entry's `specSha256` locally. It hides that content, including identical copies
  received later, and blocks no one.
- The blocklist (hidden spec hashes, blocked hosts) is local app state, never exported. A repository
  decorator applies it to every reader, so a hidden entry is absent from the list, MCP `open` and
  the viewer.
- Hiding deletes. Confirming Hide or Block deletes every matching received entry (bundle, metadata
  and viewer storage); only the hash or host stays, in the blocklist. The confirmation says so. App
  start repeats the sweep, so an entry whose delete failed before its metadata was removed is
  retried. The app rejects a later file or share import of hidden content, or of content from a
  blocked host, as `Hidden` ("hidden on this device"). It does so before anything is staged or
  stored, so hidden content does not hold library quota. The repository repeats that check under
  its lock when it commits the entry. The purge lists through the same lock after Hide records the
  hash, so an import that races Hide is either rejected or deleted by that purge. There is no unhide.
- Report opens the user's mail app addressed to the published contact
  (`automobile+coc@jasonpearson.dev`, the project's code-of-conduct enforcement address) with the
  label, spec SHA-256, source and host. The app sends nothing itself and attaches no bundle bytes.
  The library shows the same contact in a "Report a problem" row.

Bundle limits (shared TS/Kotlin/Swift transport contract):

- `BUNDLE_MAX_ENTRIES = 36`: two JSON files + the asset contract's 32 assets + two fonts headroom;
  36 is fixed for this format, independently of future asset-contract count changes.
- `BUNDLE_MAX_SPEC_BYTES = 1,048,576`; `BUNDLE_MAX_MANIFEST_BYTES = 65,536`.
- Each image is at most `MAX_PROTOTYPE_ASSET_BYTES = 4,194,304` bytes; each font is at most
  `MAX_PROTOTYPE_FONT_ASSET_BYTES = 2,097,152` bytes, from the asset contract.
- `BUNDLE_MAX_EXPANDED_BYTES = MAX_PROTOTYPE_ASSET_TOTAL_BYTES + BUNDLE_MAX_SPEC_BYTES +
  BUNDLE_MAX_MANIFEST_BYTES = 17,891,328`; `BUNDLE_MAX_COMPRESSED_BYTES` is the same value and
  caps the entire archive file, including headers.
- `BUNDLE_MAX_RATIO = 100`: actual total inflated bytes / total compressed entry data bytes;
  the known compressed-data total supplies a hard output budget during inflation. Header sizes
  never authorize extra allocation. JSON nesting is limited to 64 levels.

The reader rejects ZIP64, nonempty extra fields or comments, data descriptors, local/central
header mismatches, overlapping entries, hidden records/preambles, extra EOCD signatures in the
last 65,557 bytes, and bytes after EOCD. Unix file types must be regular or unspecified (zero).
CRC32 precedes SHA256 verification. Every image/font reference, manifest record and ZIP entry
must match in both directions; listed-but-unreferenced IDs fail with `unreferenced_asset`.
`requires` is advisory, sorted and unique. The reader validates strict spec JSON with the existing
validator; library policy/capability checks remain the importing app's responsibility.

Canonical export preserves spec bytes verbatim and uses compact manifest JSON without a newline.
It sorts manifest arrays by ID (UTF-16 code units, exact identity without Unicode normalization)
and ZIP asset/font entries by filename, and deduplicates identical
content paths.

ZIP entries are STORED, flags 0, DOS date/time 1980-01-01 00:00:00, made-by/version
20 (MS-DOS), external attributes 0, with no extras, comments or descriptors. Private record and
library metadata never enter the transport manifest; authored spec bytes are not redacted.
The shared `test/fixtures/prototype-bundle/corpus.json` contains the error vocabulary, limits,
portable hostile ZIPs and canonical export inputs/bytes. Generated PNG/signature/font-tag probes
are not captured user assets. The oversized whole-file and combined-expanded boundaries are
also tested in TS without committing megabytes of base64. Commits target fresh library IDs in an
app-owned parent directory; callers serialize commits and the Node adapter uses exclusive
`O_NOFOLLOW` writes, `lstat`/directory-open checks, 0700 staging, cleanup and same-volume rename.

## 5. Import validation flow

1. Source-side caps before parsing: bare JSON at most 1 MiB, bundle within the compressed cap,
   stream-limited reads. The caller-supplied MIME type and filename are ignored. On Android the
   exported `ImportActivity` accepts only `content://` data from other authorities and rejects
   `file://` and ProtoViewer's own authority. The MCP route (section 7) never goes through that
   exported entry point. It uses a separate, non-exported internal import path that reads only from
   the app-scoped inbox directory and runs the same steps 2 to 8. That path checks the canonical
   path, accepts regular files only, and deletes the inbox entry after the import attempt.
2. The strict zip reader (section 4) for bundles.
3. Strict JSON parse: BOM strip, duplicate keys rejected, depth-limited.
4. The full validator (TS and Kotlin full; Swift reject-only port). It rejects unknown keys and
   `window.layer: "system"`. It rejects `secure` and `password` bindings into request URL, headers,
   query or body and into `storage`. It rejects forbidden request headers (`Host`, `Connection`,
   `Upgrade`, `Proxy-*`, `Cookie`) and CR/LF, and `via: "host"` for library prototypes.
5. Capability check: `PROTOTYPE_SPEC_CAPABILITY_GATES` against the app's capability set, yielding
   "needs a newer ProtoViewer" rather than a partial render. `requires` in `bundle.json` is advisory
   and cross-checked.
6. Asset checks: sha256, magic bytes, pixel budget and per-file caps. **Reference completeness is
   checked on every platform**: every image and font ID referenced by `spec.json` must have a
   `bundle.json` entry and a matching zip entry, and every `bundle.json` entry must have a zip entry.
   A missing referenced asset rejects the whole import with the offending path; it is never
   committed with a placeholder. iOS must not rely on the placeholder behaviour of
   `PrototypeSavedLayout` for imports. The corpus has invalid fixtures for a missing image, a
   missing font and a manifest entry without a zip entry (#13620).
7. There is no static network scan, because URLs are templated. Network policy is applied at request
   time (section 6).
8. Commit atomically; the app assigns `libraryId` and `source`.

Version compatibility: there is no `specVersion`. Compatibility is the strict validator of the
app's release plus the capability gates. There are no migrations. A store-installed app lags or
leads the MCP server, so the host also checks capabilities before an MCP save (section 7,
capability handshake). Step 5 stays the authority for every import, including builds that predate
the handshake.
