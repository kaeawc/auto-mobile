# ProtoViewer: a prototype library app for iOS and Android

Accepted design for epic #13625: a ProtoViewer app on iOS and Android to switch between, relaunch,
share, download and view any prototype that is a valid AutoMobile JSON SDUI spec.

## 1. Current state

- **Spec and validation.** Contract `schemas/prototype-spec-contract.json`; host validator
  `src/features/prototype/prototypeSpec.ts` / `prototypeValidation.ts`; Kotlin twin
  `PrototypeSpecValidator` (`android/protocol`); Swift reject-only `PrototypeSpecStrictValidator`
  (#14803, see [iOS prototype agent](plat/ios/prototype-agent.md)). All three consume the shared
  valid/invalid corpus with no exemptions. Unknown keys and malformed storage reject the whole spec.
- **Envelope** `{ id, window, data?, state?, motion?, storage?, theme?, root }`. There is **no
  `specVersion`**: the 2026-10-04 owner decision rejects older and newer shapes instead of migrating
  (see [Android prototype specification](plat/android/prototype-ux.md)). Evolution is by device
  capabilities (`PROTOTYPE_SPEC_CAPABILITY_GATES` in `prototypeCapabilityGates.ts`).
- **Limits:** 1 MiB spec, 2000 nodes, depth 24, 32 images, data 256 KiB, storage 64 keys / 256 KiB,
  4 requests in flight, 30 s timeout. `readPrototypeSpecFile` does stat-then-read size caps, BOM strip
  and JSON parse for `specPath`.
- **Showing today.** MCP `prototype` tool (`src/server/prototypeTools.ts`): `show` (inline `spec` or
  host-side `specPath`), `patch`, `dismiss`, `status`, `inspect`, `awaitEvent`, `save`, `listSaved`,
  `deleteSaved`, `clearStorage`. Android: CtrlProxy Compose overlay (`ctrlproxy/prototype/*`,
  `androidPrototypeTransport.ts`). iOS simulator: injected dylib `ios/prototype-agent` (#10563).
- **Saved prototypes (no host needed).** Android: `SavedPrototypeStore` / `SavedPrototypeDirectoryStore`
  (app-private slug dirs, manifest last, content-hash assets, max 50), `SavedPrototypeActivity` (one
  document task per id, not exported), pinned shortcuts, per-id storage under
  `filesDir/prototype-storage/`, all inside the CtrlProxy APK. iOS (#12251): per-prototype app copy of
  `ios/prototype-agent/Viewer` installed by `iosPrototypeInstaller.ts`, spec at
  `Documents/prototype/{manifest.json,spec.json,assets,fonts}` (formatVersion 1, one per container),
  template `AutoMobilePrototypeViewer.zip` from `build-prototype-viewer.yml`, simulator only. Shared
  layout code in `savedPrototypeLayout.ts` and Swift with fixture
  `test/fixtures/prototype-saved-layout/layout.json`.
- **Data and network (#12518).** `request` with `via: host|device` (Retrofit on Android, `URLSession` on
  iOS). That stands for MCP-direct flows; library prototypes need a pinned iOS transport (section 6).
- **Missing:** library UI, multi-prototype iOS viewer, import/export/share, opening a `.json` or URL, a
  physical iPhone path, an on-device list of Android saved prototypes.

## 2. Goals and non-goals

Goals

1. Library: names and last opened; switch to any prototype in one tap.
2. Relaunch (restart from the spec) and Reset (relaunch plus clearing that prototype's storage).
3. Share: export a clean, validated `.automobile-proto` bundle through the system share sheet or a
   file.
4. Import: file open and share-sheet receive, with validation errors that name the path.
5. View: render with the existing renderers, offline, including saved storage and `via: "device"`
   requests.
6. MCP integration: `save` lands in the library, and an agent can open a given prototype.
7. The same experience on Android (Material 3) and iOS (SF Symbols).

Non-goals for the first release: spec migration or a `specVersion`, an editor, cloud sync or
accounts, a sharing service, Play Store or App Store listings, running arbitrary code (specs stay
declarative).

## 3. Architecture

### 3.1 Standalone, unprivileged apps

iOS declares `NSLocalNetworkUsageDescription`; the first LAN connection prompts for local-network access.

A standalone app per platform reuses the existing renderer and saved-prototype code. Library
prototypes never render inside CtrlProxy: it is an accessibility service, input method and overlay,
and its renderer honours privileged window options. ProtoViewer declares `INTERNET` and the
runtime-granted `ACCESS_LOCAL_NETWORK` permission that Android 17 (API 37) requires for private LAN
connections, and nothing else (no accessibility, input method, overlay, device-admin or camera).
`ACCESS_LOCAL_NETWORK` is requested only when the user turns on "Allow network for imported
prototypes" (section 6), never at install or first launch; if it is denied, the switch turns off and
the library explains that network access is disabled until permission is granted (Android slice 3,
closing #14539 via this work). The validator rejects `window.layer: "system"` and any other privileged window
option for library prototypes.

- **Android renderer extraction is one mechanical move.** The `ctrlproxy/prototype` package imports
  only a few symbols from the rest of CtrlProxy, so moving it to a `:prototype-render` module
  (Compose plus `android/protocol`) is a rename plus three seams. CtrlProxy keeps
  `SavedPrototypeActivity` and shortcuts on top of the library (#13617).
- **iOS** links the existing `AutoMobilePrototypeAgent` SwiftPM library, as the current `Viewer`
  does. The per-prototype simulator template stays as "pin to home screen".

### 3.2 Validation parity (critical path)

Import needs identical accept/reject behaviour on all three platforms.

1. `PrototypeSpecStrictValidator.validate(data:supportedCapabilities:library:)` takes raw UTF-8 `Data`
   and returns or throws `PrototypeLoadError.invalidSpec(path:message:)`. It extends
   `PrototypeContractValidator` and generated `PrototypeSpecContractData.swift`; it neither replaces the
   interpreter nor returns a render model. Existing runtime helpers supply request, platform, state
   binding, check grammar, repeat and limit rules; extra checks keep authored paths for cross-node
   targets, charts, storage and template scope.
2. All three corpus runners discover **every** `.json` in
   `test/fixtures/prototype-spec/{valid,invalid}` and compare with `corpus.json`, which also records
   TS-computed capabilities per valid spec. An added fixture without a refreshed inventory fails each
   runner. Capture with `bun scripts/capture-prototype-strict-fixtures.ts` (`expectedPath` is real TS
   output). Assertions compare acceptance and error path, never message text.
3. An invalid envelope holds `spec` or, when JSON can't preserve the input, `rawJson` (duplicate keys,
   escaped surrogates, non-JSON tokens, nesting) or `rawBytesBase64` (invalid UTF-8), plus
   `expectedPath` and optional `options` (`library`, `supportedCapabilities`). The `.gitattributes` JSON
   rule pins LF.
4. Raw input: one leading BOM allowed; duplicate keys (including escaped aliases), lone surrogates,
   invalid UTF-8, nonfinite tokens and more than 128 JSON containers reject at `$` before decoding.
   Semantic tree/data depths stay 24/8. Numbers follow TS doubles (`-0`, above 2^53); IDs keep the TS
   grammar with no extra length or normalization rule.
5. Capability computation is independent of the renderer; a supplied capability set rejects missing
   features at `$`. `library: true` also rejects explicit system windows and device persistence (host
   validation still accepts them for CtrlProxy). Forbidden headers and literal CR/LF reject in every
   mode. Network routing and secure-binding policy (section 5) still need the import boundary.
6. Import never partially renders or stores a failed spec. Element anchors are structurally valid but
   the embedded loader needs host-resolved bounds (three fixtures). Storage version/key shape is
   validated here; persisted-version mismatch stays the storage restore/drop policy. Runtime-only caps
   (in-flight calls, response bytes, stack navigation, patch operations) are tested at runtime
   boundaries. The data-write pair is captured after a real TS write: data fits its budget but repeat
   expansion exceeds the node budget.

### 3.3 Android app

- `minSdk` is 26: a new standalone app, and the bundle commit relies on `java.nio` NOFOLLOW checks and atomic same-volume moves.
- Package `dev.jasonpearson.automobile.protoviewer`. `LibraryActivity` is the launcher list,
  `ViewerActivity` is a document task per prototype (not exported), and an exported `ImportActivity`
  handles VIEW and SEND for `content://` data only.
- Storage reuses the `SavedPrototypeDirectoryStore` layout, keyed by an **app-generated library
  id** (a UUID from `IdGenerator`), never `spec.id`. `allowBackup=false` and
  `dataExtractionRules` exclude the library. The prototype storage file name derives from the
  library id.
- Relaunch finishes the task and starts `ViewerActivity` again. Reset is relaunch plus clearing that
  library id's storage. Delete removes the spec, assets and storage.
- Share rebuilds a clean bundle (section 4) and hands it out through a `FileProvider` scoped to an
  export-cache subdirectory, with a read-only temporary grant and the temp file deleted afterwards.
- Fonts and images decode off the main thread.

### 3.4 iOS app

- SwiftUI `ProtoViewer`: `LibraryView` (SF Symbols only) and `PrototypeScreen` hosting
  `ViewerRenderer` with `PrototypeModel(mode: .standalone, storage: .fileBacked())` in a
  per-library-id namespace.
- Data lives in Application Support (not Documents, no `UIFileSharingEnabled`) with
  `isExcludedFromBackup` set. Each prototype directory is `PrototypeSavedLayout` formatVersion 1,
  unchanged, plus the sibling `library.json` (section 4).
- Import uses `fileImporter` and `onOpenURL` (document UTI `dev.jasonpearson.automobile.prototype`).
  Image decode has a pixel budget and a PNG/JPEG/WebP magic-byte allowlist before `UIImage(data:)`.
  Fonts are unregistered when switching prototypes.
- Network: requests go through a pin-capable transport, not `URLSession`; App Transport Security is
  relaxed only in the simulator and dev build; see section 6.

### 3.5 Open-source notices (#14158)

Both apps list the licenses of everything they ship under Settings, "Open-source licenses", and
link `SECURITY.md` beside it. The lists are generated, never hand-maintained.

- **Android**: the AboutLibraries Gradle plugin (`com.mikepenz.aboutlibraries.plugin.android`,
  version in `libs.versions.toml`) collects the release runtime classpath at build time into
  `res/raw/aboutlibraries.json`. Only the plugin is applied: `LicensesActivity` parses the JSON with
  the existing kotlinx.serialization dependency, so the app links no extra runtime library. The
  plugin runs offline, so the full Apache-2.0 text comes from
  `android/protoviewer/license-config/licenses/Apache-2.0.json` (a test pins it to the repository
  `LICENSE`). Strict mode fails the build for any license outside the allow-list, and a unit test
  fails when a bundled dependency has no license entry or no license text. Alternatives checked:
  Google's `oss-licenses-plugin` (its UI is the Play services `play-services-oss-licenses` runtime
  library, which an unprivileged offline app should not link), and licensee (validates licenses but
  is not a notice generator). No such plugin existed in the build before.
- **iOS**: `scripts/ios/protoviewer-notices.ts` reads the SwiftPM graph of `ios/prototype-agent`
  (`swift package show-dependencies --format json`, so transitive packages and resolved versions are
  covered), adds each package's license text from
  `ios/prototype-agent/ProtoViewer/third-party-licenses/<identity>.txt`, and writes
  `ProtoViewer/Acknowledgements.generated.swift`, which the viewer build compiles in. Today the graph
  is first party only, so the list holds the AutoMobile Apache-2.0 notice. When a package is added:
  commit its license text, run `bun scripts/ios/protoviewer-notices.ts`, and add the package
  directory to `.github/dependabot.yml`. A missing text, or a text for a package no longer linked,
  fails the script.
- **Drift check**: `scripts/prepush-ios.sh` and the `protoviewer-notices` Fast Validation check run
  the script with `--check`. On macOS it rebuilds the output from SwiftPM and fails when the
  committed Swift file differs. Elsewhere, where the pinned Swift toolchain may be absent, the
  generated header records a digest of `Package.swift`, `LICENSE` and the license texts, and the
  check fails when the digest no longer matches, so any manifest edit needs a regeneration on macOS.

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
  "pinned": false
}
```

`source` and trust are app-owned: the importing code path writes them from how the bytes arrived,
and they are never read from bundle bytes. The file is never part of an export. A corrupt or
unreadable `library.json` entry is skipped, not fatal.

**Bundle (share and import) format**, separate from the store manifests (#13616). `*.automobile-proto`
is a zip, MIME `application/vnd.automobile.prototype+zip`, iOS UTI
`dev.jasonpearson.automobile.prototype`. The strict zip reader accepts exactly:

- Entries: `bundle.json`, `spec.json`, `assets/[0-9a-f]{64}\.(png|jpg|webp)` and
  `fonts/[0-9a-f]{64}\.(ttf|otf)`. It rejects directories, parent-relative or absolute paths,
  backslashes, NUL, non-ASCII names, `__MACOSX`, duplicate names, symlink or nonregular Unix file-type attributes,
  encrypted entries, compression methods other than STORED and DEFLATE, and multi-disk archives.
- `bundle.json`: `{ "bundleFormatVersion": 1, "specSha256": "...", "assets": [{id,file,sha256,mediaType}], "fonts": [...], "requires": [capabilities] }`.
  Strict; no label, source or storage. Each platform's importer translates it into its own store
  layout.
- The reader streams, counts inflated bytes rather than trusting header sizes, allows at most 36
  entries, applies the per-file caps from `schemas/prototype-asset-contract.json`, one compressed
  cap and one expanded cap derived from the contract, and a ratio cap; it verifies sha256 after
  inflating, stages in a fresh directory and commits atomically.
- A bare spec (`*.json`, `application/json`, at most 1 MiB, no assets) is also accepted.
- **Export rebuilds a canonical bundle** from `spec.json` plus only the assets the spec references:
  never storage, `library.json`, a source URL or last-opened time. A preflight scan warns before
  share about credential-like headers and query keys and private or loopback hosts. No thumbnails in
  the first release.
- Importing a prototype whose `spec.id` already exists creates a new entry with its own library id
  and empty storage. Replace and keep-both are later work.
- Not in the first release: user-facing URL import, universal links, compact `?spec=` links, QR. The
  one custom URL scheme in the first release is the internal launch scheme `automobile-proto://`
  (section 7): it imports a host-staged inbox bundle or opens an existing library entry.
  The scheme never fetches or carries spec bytes.

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

Canonical export preserves spec bytes verbatim, uses compact manifest JSON without a newline,
sorts manifest arrays by ID (UTF-16 code units, exact identity without Unicode normalization)
and ZIP asset/font entries by filename, and deduplicates identical
content paths. ZIP entries are STORED, flags 0, DOS date/time 1980-01-01 00:00:00, made-by/version
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
   exported entry point: it uses a separate, non-exported internal import path that reads only from
   the app-scoped inbox directory (canonical-path check, regular files only, the inbox entry is
   deleted after the import attempt) and runs the same steps 2 to 8.
2. The strict zip reader (section 4) for bundles.
3. Strict JSON parse: BOM strip, duplicate keys rejected, depth-limited.
4. The full validator (TS and Kotlin full; Swift reject-only port): unknown keys rejected,
   `window.layer: "system"` rejected, `secure` and `password` bindings into request URL, headers, query or
   body and into `storage` rejected, forbidden request headers (`Host`, `Connection`, `Upgrade`,
   `Proxy-*`, `Cookie`) and CR/LF rejected, and `via: "host"` rejected for library prototypes.
5. Capability check: `PROTOTYPE_SPEC_CAPABILITY_GATES` against the app's capability set, yielding
   "needs a newer ProtoViewer" rather than a partial render. `requires` in `bundle.json` is advisory
   and cross-checked.
6. Asset checks: sha256, magic bytes, pixel budget and per-file caps. **Reference completeness is
   checked on every platform**: every image and font ID referenced by `spec.json` must have a
   `bundle.json` entry and a matching zip entry, and every `bundle.json` entry must have a zip entry.
   A missing referenced asset rejects the whole import with the offending path; it is never
   committed with a placeholder. iOS must not rely on the placeholder behaviour of
   `PrototypeSavedLayout` for imports, and the corpus gains invalid fixtures for a missing image, a
   missing font and a manifest entry without a zip entry (#13620).
7. There is no static network scan, because URLs are templated. Network policy is applied at request
   time (section 6).
8. Commit atomically; the app assigns `libraryId` and `source`.

Version compatibility: there is no `specVersion`. Compatibility is the strict validator of the
app's release plus the capability gates. There are no migrations.

## 6. Network policy and limits

**Imported prototypes (library imports, and prototypes saved through MCP, which follow the same
policy):** one global switch, "Allow network for imported prototypes", **default off**. When off,
`request` actions fail with a typed error shown to the prototype (`statusKey` `error`). Switching
network off cancels in-flight Android and iOS requests and drops late responses, even after a quick
off/on cycle. On iOS, permission-denial callbacks are bound to the request's consent epoch and
rechecked on the main actor; response delivery rechecks consent in the same turn that updates
prototype state, replacing obsolete successes and failures with the network-disabled error.
Per-host consent is later work. MCP-direct `show` keeps today's behaviour. When on:

- The egress check runs in the HTTP client on the resolved address, at every hop. It blocks
  loopback, link-local ranges, the emulator host alias `10.0.2.2`, and the AutoMobile daemon ports.
  **Private LAN ranges (RFC1918) are allowed.** The client resolves once, checks every returned
  address, and connects to a checked address rather than resolving again, and it normalizes
  alternate address spellings before checking. TLS still validates against the original host name.
- **Transport requirement.** The guarantee above requires a client that can connect to a specific
  resolved address. Android's HTTP client can (a custom DNS resolver that returns the checked
  address). iOS `URLSession` cannot: it performs its own lookup, the answers are not pinned, and
  its metrics only report a blocked connection after the request may have been sent, so
  `URLSession` does not enforce this boundary for library prototypes. The iOS app therefore sends
  library-prototype requests through a pin-capable transport built on Network.framework
  (`NWConnection` to the checked `NWEndpoint.hostPort`, TLS with the original host name as the
  server name for SNI and certificate validation, and a small HTTP/1.1 client with the existing
  size, time and header limits). The checked address is the only one dialled. The path monitor and
  connection state callbacks are used to refuse a connection whose remote endpoint differs from the
  checked address. The transport is `PrototypePinnedHttpClient`, selected through
  `PrototypeNetworkConfiguration.pinned`. The ProtoViewer network switch is wired on iOS (#13619): switching off cancels
  in-flight requests and drops late responses across off/on cycles. A pending local-network permission
  prompt cannot be distinguished from denial: the switch turns off only when a LAN connection ends
  while still waiting on permission, and explains that access was not granted and how to restore it.
  Device verification of the prompt-pending and denied flows is still owed. `URLSession` stays in use only for MCP-direct
  `show` flows, which keep today's behaviour, and it is never described as enforcing this policy.
  The egress check and resolver are an injected interface with a fake in tests.
- Redirects are not followed automatically; each redirect is evaluated as a new request, and an
  https-to-http redirect is refused.
- Forbidden request headers are enforced in both the validator and the runtime. Cleartext http is
  permitted only in the dev flavor.
- Library prototypes use the device route only: `via: "host"` is rejected, and ProtoViewer never
  sets up `adb reverse`.
- A provenance indicator lives in an app-reserved region outside the spec's drawable bounds and
  stays visible while network is enabled.
- Storage is keyed by library id; a new import starts empty. The bundle carries no prototype id (its
  identity is `specSha256` plus the `spec.id` inside `spec.json`), so there is no bundle-id
  comparison; the only identity checks are `bundle.json.specSha256` against the inflated
  `spec.json` and the app-assigned library id.
- Imported-prototype content is marked as imported in `observe` and `awaitEvent`; `open` states
  when an entry is imported; host attach is off by default for imported prototypes.
- Limits: 200 prototypes and 100 MiB per library, enforced at commit and on load, plus a render
  watchdog. Android allows 10 seconds for loading and the first successful content composition;
  timeout or composition failure shows the corrupt state with Back. iOS allows the same 10 seconds
  from mount to the first laid-out content (`PrototypeRenderWatchdog`, cancelled by the renderer's
  first layout in a window) and then shows the error state; a blocked main thread is not caught. Android sets `allowBackup=false` and allows no cleartext outside the dev flavor. iOS
  distributed (non-simulator) builds carry no App Transport Security exception.

The shared request-policy and storage work is tracked in #13622.

## 7. MCP integration (first release: save routing and open)

- Android uses adb, the existing device channel (#13621): the host pushes the bundle into
  ProtoViewer's app-scoped inbox, `getExternalFilesDir(null)/mcp/inbox/<request>.automobile-proto`,
  then runs `am start -n dev.jasonpearson.automobile.protoviewer/.McpActivity` with action
  `….mcp.IMPORT` and the request id (plus an optional label). `McpActivity` is a separate component
  from the exported `ImportActivity` (section 5 step 1). It is exported only to callers holding
  `android.permission.DUMP` and has no intent filters: the adb shell holds DUMP and third-party apps
  cannot, and a non-exported activity could not be started from adb at all. It reads the inbox
  file under the same byte caps, deletes it, and runs the full import flow; the source is always
  `mcp`, set by the app, never by the caller or the bundle, so the entry is "imported" and the
  section 6 policy applies. It writes one result, `mcp/results/<request>.json`
  (`imported`/`opened` with `libraryId` and `label`, `rejected` with `path` and `reason`, or
  `not_found`), under a temporary name and renames it; the host polls for it and removes it. The
  exported `ImportActivity` keeps rejecting `file://` and its own authority. On API 30+ scoped
  storage a directory the adb shell creates under another app's `Android/data` is shell-owned and
  the app can neither traverse it nor create entries in it (#15174, seen on API 37), while the
  shell can still write a file into a directory the app created. So the app owns `mcp/`,
  `mcp/inbox/` and `mcp/results/`: it creates them on start, and the host never runs `mkdir`; when
  they are missing it first starts `McpActivity` with action `….mcp.PREPARE`, which creates them
  and answers `prepared`. The host's result poll treats "not there yet" as pending until its
  deadline (a bare `cat` of a missing file exits 1, which adb turns into an error). When the
  folders cannot be prepared, the push is refused, or the app answers `rejected` at `inbox` (it
  cannot see the pushed file), nothing was imported and the host keeps the CtrlProxy save path
  with a logged warning instead of failing the call.
- iOS simulators use the host filesystem and `simctl openurl`, without a new socket or broadcast.
  The host resolves the app's own data container and creates
  `Library/Application Support/ProtoViewer/mcp/inbox/` and `results/` (same host uid as the app);
  the app also creates them idempotently on start and never purges this inbox at launch.
  Import writes `inbox/<request>.automobile-proto.tmp` then renames it, and delivers
  `automobile-proto://import?request=<request>&label=<percent-encoded-label>` (label optional).
  Open delivers `automobile-proto://open?request=<request>&id=<libraryId>`.
  Request ids match `[A-Za-z0-9_-]{1,64}`. The scheme carries no spec bytes. The app validates the
  full import, sets `source: mcp` itself, removes the inbox file after every attempt, and atomically
  publishes `results/<request>.json` using the same result shapes as Android. Rejections are
  reported in that file rather than an alert. Open reports `opened` only after the viewer loads.
  Host polling treats a missing result as pending until the timer deadline; finally it removes
  results and leftover inbox files even after cancellation, with an independent cleanup timeout.
  An absent app, unresolved container, unusable inbox, or nonzero `openurl` exit keeps the template
  save path with a logged warning. Command timeout or result deadline after delivery is a hard
  failure: the save may still have landed, so check ProtoViewer before retrying.
  Physical devices keep the template path's existing behavior; `open` needs an iOS simulator.
  `devicectl` delivery to dev-signed physical devices remains later work.
- `prototype save`: on Android (for the current user) or an iOS simulator, when ProtoViewer is installed, build a
  canonical bundle (#13616) and route it as above; otherwise the CtrlProxy or template path is
  unchanged. `pin` and `icon` describe CtrlProxy launcher shortcuts, which ProtoViewer has not, so
  a save with either keeps the platform save path. The output gains `viewer` `{app, libraryId, label}`
  and a warning that the entry is imported.
- `prototype open` (new action) launches a library id (`viewer.libraryId`) through the same
  activity with action `….mcp.OPEN` on Android or the iOS simulator URL route, and returns the same warning.
- Not in the first release: MCP `export` and `import` actions, a `listSaved` merge, live attach.

## 8. Distribution

Both platforms ship in the first release, from **GitHub releases only** (no Play Store or App Store
listing):

- Android: a signed APK as a release asset next to CtrlProxy, with a pinned checksum.
- iOS: dev-signed builds installed on the owner's iPhones (an Apple Developer team is configured).
  The simulator template remains available.

### 8.1 Play-ready Android artifact (#14146)

The Android module builds a Play-uploadable AAB next to the APK. The Gradle side is the
`automobile.protoviewer-play-release` convention in `android/build-logic`; it replaces the shared
`automobile.android-app-signing` for ProtoViewer, which falls back open to the debug key.

**Dedicated keystore.** ProtoViewer has its own signing key, never CtrlProxy's `RELEASE_KEYSTORE_*`.
Inputs are read from the environment (CI) or `gradle.properties` (local):

| Input                                 | Purpose                                                   | CI secret                       |
| ------------------------------------- | --------------------------------------------------------- | ------------------------------- |
| `PROTOVIEWER_KEYSTORE_PATH`           | keystore file (relative paths resolve against `android/`) | `PROTOVIEWER_KEYSTORE_BASE64`   |
| `PROTOVIEWER_KEYSTORE_PASSWORD`       | store password                                            | `PROTOVIEWER_KEYSTORE_PASSWORD` |
| `PROTOVIEWER_KEY_ALIAS`               | key alias                                                 | `PROTOVIEWER_KEY_ALIAS`         |
| `PROTOVIEWER_KEY_PASSWORD`            | key password                                              | `PROTOVIEWER_KEY_PASSWORD`      |
| `PROTOVIEWER_RELEASE_VERSION`         | plain `MAJOR.MINOR.PATCH` of the release tag              | (workflow input)                |
| `PROTOVIEWER_REQUIRE_RELEASE_SIGNING` | `true` in release workflows: fail closed                  | (workflow env)                  |

The workflow decodes `PROTOVIEWER_KEYSTORE_BASE64` to a file and exports its path as
`PROTOVIEWER_KEYSTORE_PATH`. Whether this key is the Play upload key or the app-signing key is
decided at Play App Signing enrolment; record it next to the key.

**Fail closed.** With `PROTOVIEWER_REQUIRE_RELEASE_SIGNING=true`, `verifyProtoViewerReleaseInputs`
(a `preReleaseBuild` dependency, so it fails before compilation) rejects a missing signing input, a
missing keystore file, a missing `PROTOVIEWER_RELEASE_VERSION`, or a `-SNAPSHOT`/suffixed version.
Without it (local and pull-request builds) an incomplete keystore falls back to the debug key and
the version code stays `1`. Debug builds always use the debug key, never the release key.

**versionCode.** `major * 1_000_000 + minor * 1_000 + patch` of `PROTOVIEWER_RELEASE_VERSION`
(`ProtoViewerVersioning`). It is strictly monotonic in version order, bounded under Play's
2,100,000,000 cap (major <= 2099, minor and patch <= 999), and `0.0.89` gives `89`. The release
`versionName` is the same plain version, so a published build never carries `-SNAPSHOT`.

**AAB, R8 and mapping.** `:protoviewer:bundleRelease` writes
`build/outputs/bundle/release/protoviewer-release.aab` and is finalized by
`verifyProtoViewerReleaseAab` (required entries, jar signature present and not the Android debug
certificate when signing is required, R8 mapping present) and, when R8 is on,
`archiveProtoViewerReleaseMapping` (`build/outputs/release-archive/mapping-<versionCode>.txt`, to
be kept as a release asset for as long as that version is supported). R8 is on for release (disable
locally with `-Pautomobile.protoviewer.minifyRelease=false`); `verifyReleaseR8KeptClasses` asserts
the manifest components, the saved-prototype `@Serializable` contract and the reflectively resolved
icon set survive. Unused `:protocol` wire models are shrunk away.

Not yet wired: the release workflow step that exports these inputs and uploads the AAB and mapping,
`lintRelease` in CI, and the `bundletool build-apks` install smoke test on a device.

## 9. Phased plan

**First release.** Library list; open/switch; relaunch/reset; delete; share a clean bundle; import by
file or share sheet; MCP `save` routing and `open`; global network switch; shared hardening. Not
included: thumbnails, search, keep-both/replace, compact links, MCP export/import, per-host consent,
URL/QR import, universal links. Order: (1) corpus, strict zip reader, Swift validator in parallel with
(2) the Android extraction; then (3) Android app, (4) hardening, (5) MCP routing, (6) iOS app.

**Phase 2.** Per-host consent UI, URL import (https only, confirmation, egress check on the fetch), QR,
thumbnails, search, replace/keep-both, font opt-in. **Phase 3.** Store tracks, universal links, MCP
export/import, live attach for imported prototypes (off by default).

## 10. Test plan

Unit tests (fakes and FakeTimer, each under 100 ms): strict zip reader (paths, duplicates, links, size
and ratio limits, header-size mismatch, encryption, methods); `bundle.json` strictness; library index (a
corrupt entry is skipped); id isolation and empty storage on import; export rebuild (no storage, source
or library fields) and preflight scan; egress check on resolved addresses with a fake resolver and fake
pinned transport (a second DNS answer is never used; loopback, `10.0.2.2`, link-local, IPv6, redirect
re-check, https to http); forbidden headers; privileged-window rejection; network switch; import size
gates; missing referenced image/font/manifest-entry bundles rejected; MCP inbox route rejected from the
exported entry point; iOS pixel budget and magic bytes. Corpus: `test/fixtures/prototype-spec` in TS,
Kotlin and Swift (accept/reject plus error path only). Device (manual-test skill; Android API 37, iOS
27.x on the owner's iPhone): MCP save to library; switch among three; relaunch; reset; delete; share and
re-import across platforms; adb push plus VIEW import; invalid-spec error; offline with stored values;
localhost request blocked and LAN request allowed with the switch on.

Import fuzzing (#14159): `scripts/prototype/bundleFuzz.ts` holds seeded generators (byte mutation, hostile
ZIP structure, hostile `bundle.json`/`spec.json`, DEFLATE bombs). They feed fast-check property tests in
TS (`prototypeBundleFuzz.property.test.ts`, unit budget) and a wider sweep (`.integration.test.ts`, safe
tier). `test/fixtures/prototype-bundle/fuzz-corpus.json` is the shared differential corpus: TS records the
verdict (accept, or code plus path) and the Kotlin (`PrototypeBundleFuzzTest`) and Swift
(`PrototypeBundleFuzzTests`) readers must reproduce it, alongside seeded per-platform mutation sweeps that
assert only typed rejections. Regenerate with `bun scripts/prototype/generate-bundle-fuzz-corpus.ts
--write`; a minimized finding becomes a fixture in `corpus.json`. Coverage-guided Jazzer/libFuzzer
harnesses and a nightly CI job remain future work.

## 11. Risks

1. Swift validator parity is the critical path (mitigated by reject-only scope and the corpus).
2. Library network policy differs from #12518's "no allowlist"; MCP-direct `show` is unchanged.
3. The extraction touches CtrlProxy (one mechanical change plus existing suites).
4. The adb-based MCP channel is Android-specific; iOS simulators use the filesystem and `simctl openurl`; physical-device delivery is later work.
5. With no `specVersion`, older apps reject newer specs; `requires` and capability messages soften this.

## 12. Decisions

| Question                   | Decision (owner, 2026-10-19)                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| iOS distribution           | Dev-signed builds on the owner's iPhones in the first release, alongside Android.                       |
| Network for imported specs | One global switch, default off; per-host consent in Phase 2; MCP-direct `show` keeps today's behaviour. |
| Stores                     | GitHub releases only.                                                                                   |
| LAN egress                 | RFC1918 LAN is allowed; loopback, link-local, `10.0.2.2` and the daemon ports stay blocked.             |
| iOS egress transport       | Network.framework (NWConnection) pinned transport (owner, 2026-10-21, #14540).                          |
| Missing referenced assets  | Reject the import on every platform with the offending path (owner, 2026-10-21, #14542).                |
| Android LAN permission     | Declare `ACCESS_LOCAL_NETWORK` + `INTERNET`, request on switch-on (owner, 2026-10-21, #14539).          |
| MCP-saved prototypes       | Follow the imported-prototype network policy.                                                           |

## Issues

Epic #13625: #13616 bundle format, #13617 Android extraction, #13618 Android app, #13619 iOS app,
#13620 validation parity, #13621 MCP routing and `open`, #13622 shared hardening, #13623 release
and CI.
