# ProtoViewer: a prototype library app for iOS and Android

Status: accepted design for epic #13625. Owner request: a ProtoViewer app on iOS and Android to
switch between, relaunch, share, download, and view any prototype that is a valid AutoMobile JSON
SDUI spec.

## 1. Current state

**Spec and validation**

- Contract: `schemas/prototype-spec-contract.json` (limits, per-node field rules). Host validator
  and types: `src/features/prototype/prototypeSpec.ts` and `prototypeValidation.ts`. Kotlin twin:
  `PrototypeSpecValidator` in `android/protocol`. Swift: `PrototypeSpec.swift` and
  `PrototypeStateValidator.swift` in `ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore`
  validate requests, data, size bounds, stacks, themes and menus, but there is no Swift twin of the
  contract validator: unknown top-level keys are ignored and a malformed `storage` block is treated
  as absent. Swift tests assert only a subset of `test/fixtures/prototype-spec/invalid`.
- Envelope: `{ id, window, data?, state?, motion?, storage?, theme?, root }`. There is **no
  `specVersion`**: the 2026-10-04 owner decision rejects older and newer shapes instead of migrating
  (see Owner decisions in [Android prototype specification](plat/android/prototype-ux.md)).
  Evolution is by device capabilities (`prototype_data_model_v1`, `prototype_storage_v1`,
  `prototype_network_v1`, ... in `prototypeCapabilityGates.ts`, `PROTOTYPE_SPEC_CAPABILITY_GATES`).
- Limits: 1 MiB spec, 2000 nodes, depth 24, 32 images, data 256 KiB, storage 64 keys / 256 KiB,
  4 requests in flight, 30 s timeout.
- `readPrototypeSpecFile` (`prototypeSpecFile.ts`) already does stat-then-read size caps, BOM strip
  and JSON parse for `specPath`.

**Showing today**

- MCP `prototype` tool (`src/server/prototypeTools.ts`): `show`, `patch`, `dismiss`, `status`,
  `inspect`, `awaitEvent`, `save`, `listSaved`, `deleteSaved`, `clearStorage`. `show` takes an inline
  `spec` or a host-side `specPath`.
- Android: the CtrlProxy overlay renderer (`ctrlproxy/prototype/*`, Compose), transport
  `androidPrototypeTransport.ts`.
- iOS simulator: the injected dylib `ios/prototype-agent` (epic #10563), a loopback socket and a
  SwiftUI window.

**Saved prototypes (no host needed)**

- Android: `SavedPrototypeStore` and `SavedPrototypeDirectoryStore` (app-private slug directories,
  manifest last, content-hash assets, 50 saved at most), `SavedPrototypeActivity` (one document task
  per id, not exported), pinned launcher shortcuts, per-id storage under
  `filesDir/prototype-storage/`. All of it lives inside the CtrlProxy APK.
- iOS (epic #12251): a per-prototype app copy of `ios/prototype-agent/Viewer` installed by
  `iosPrototypeInstaller.ts`. The spec lives at `Documents/prototype/{manifest.json,spec.json,assets,fonts}`
  (formatVersion 1, one prototype per container). The template ships as
  `AutoMobilePrototypeViewer.zip`, built by `.github/workflows/build-prototype-viewer.yml`.
  Simulator only. The Viewer already has error screens, standalone mode, host attach and
  file-backed storage.
- Shared layout code in TS (`savedPrototypeLayout.ts`) and Swift, with the common fixture
  `test/fixtures/prototype-saved-layout/layout.json`.

**Data and network (epic #12518)**: `/data` writes, storage, and `request` actions with
`via: host|device` (Retrofit on Android, `URLSession` on iOS; the owner chose `URLSession` for
#12518).

**Missing today**: a library UI, a multi-prototype iOS viewer, import, export and share, a way to
open a `.json` or URL, a physical iPhone path, an on-device list for Android saved prototypes.

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

A standalone app per platform reuses the existing renderer and saved-prototype code. Library
prototypes never render inside CtrlProxy: it is an accessibility service, input method and overlay,
and its renderer honours privileged window options. ProtoViewer declares only the `INTERNET`
permission (no accessibility, input method, overlay, device-admin or camera), and the validator
rejects `window.layer: "system"` and any other privileged window option for library prototypes.

- **Android renderer extraction is one mechanical move.** The `ctrlproxy/prototype` package imports
  only a few symbols from the rest of CtrlProxy, so moving it to a `:prototype-render` module
  (Compose plus `android/protocol`) is a rename plus three seams. CtrlProxy keeps
  `SavedPrototypeActivity` and shortcuts on top of the library (#13617).
- **iOS** links the existing `AutoMobilePrototypeAgent` SwiftPM library, as the current `Viewer`
  does. The per-prototype simulator template stays as "pin to home screen".

### 3.2 Validation parity (critical path)

Importing a prototype needs identical accept and reject behaviour on all three platforms:

1. A hand-ported, reject-only Swift validator (`PrototypeSpecStrictValidator`): strict envelope and
   keys at every level, duplicate JSON keys, `storage` shape, limits, capability computation and
   privileged-window rejection. It returns accept or `(path, message)`; it does not need
   Kotlin-identical message text or a render model.
2. A shared corpus extending `test/fixtures/prototype-spec/{valid,invalid}` (no new directory).
   Every invalid fixture is rejected by TS, Kotlin and Swift. The assertion is accept or reject plus
   the error path, never message text. Differential cases cover unknown keys everywhere, duplicate
   keys, numeric and encoding edge cases, deep nesting, reserved key names, id edge cases, URL
   forms, forbidden headers, and every limit at the boundary and one past it (#13620).
3. Import never partially renders: a spec that fails any check is not stored.

### 3.3 Android app

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
- Network: App Transport Security is relaxed only in the simulator and dev build; see section 6.

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
  backslashes, NUL, non-ASCII names, `__MACOSX`, duplicate names, symlink or unix-mode attributes,
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
- Not in the first release: URL schemes and universal links, compact `?spec=` links, QR.

## 5. Import validation flow

1. Source-side caps before parsing: bare JSON at most 1 MiB, bundle within the compressed cap,
   stream-limited reads. On Android only `ContentResolver` data from other authorities is accepted;
   `file://` is rejected and the caller-supplied MIME type and filename are ignored.
2. The strict zip reader (section 4) for bundles.
3. Strict JSON parse: BOM strip, duplicate keys rejected, depth-limited.
4. The full validator (TS and Kotlin full; Swift reject-only port): unknown keys rejected,
   `window.layer: "system"` rejected, `secure` and `password` bindings into request URL, headers or
   body and into `storage` rejected, forbidden request headers (`Host`, `Connection`, `Upgrade`,
   `Proxy-*`, `Cookie`) and CR/LF rejected, and `via: "host"` rejected for library prototypes.
5. Capability check: `PROTOTYPE_SPEC_CAPABILITY_GATES` against the app's capability set, yielding
   "needs a newer ProtoViewer" rather than a partial render. `requires` in `bundle.json` is advisory
   and cross-checked.
6. Asset checks: sha256, magic bytes, pixel budget and per-file caps.
7. There is no static network scan, because URLs are templated. Network policy is applied at request
   time (section 6).
8. Commit atomically; the app assigns `libraryId` and `source`.

Version compatibility: there is no `specVersion`. Compatibility is the strict validator of the
app's release plus the capability gates. There are no migrations.

## 6. Network policy and limits

**Imported prototypes (library imports, and prototypes saved through MCP, which follow the same
policy):** one global switch, "Allow network for imported prototypes", **default off**. When off,
`request` actions fail with a typed error shown to the prototype (`statusKey` `error`). Per-host
consent is later work. MCP-direct `show` keeps today's behaviour. When on:

- The egress check runs in the HTTP client on the resolved address, at every hop. It blocks
  loopback, link-local ranges, the emulator host alias `10.0.2.2`, and the AutoMobile daemon ports.
  **Private LAN ranges (RFC1918) are allowed.** The client resolves once and connects to the checked
  address, and normalizes alternate address spellings before checking.
- Redirects are not followed automatically; each redirect is evaluated as a new request, and an
  https-to-http redirect is refused.
- Forbidden request headers are enforced in both the validator and the runtime. Cleartext http is
  permitted only in the dev flavor.
- Library prototypes use the device route only: `via: "host"` is rejected, and ProtoViewer never
  sets up `adb reverse`.
- A provenance indicator lives in an app-reserved region outside the spec's drawable bounds and
  stays visible while network is enabled.
- Storage is keyed by library id; a new import starts empty. Android rejects a bundle whose declared
  id differs from `spec.id`.
- Imported-prototype content is marked as imported in `observe` and `awaitEvent`; `open` states
  when an entry is imported; host attach is off by default for imported prototypes.
- Limits: 200 prototypes and 100 MiB per library, enforced at commit and on load, plus a render
  watchdog. Android sets `allowBackup=false` and allows no cleartext outside the dev flavor. iOS
  distributed (non-simulator) builds carry no App Transport Security exception.

The shared request-policy and storage work is tracked in #13622.

## 7. MCP integration (first release: save routing and open)

- Android uses adb, the existing device channel: the host pushes the bundle into ProtoViewer's
  app-scoped inbox and starts `ImportActivity` with a VIEW intent. The source is set by the app,
  never by the caller or the bundle, so the entry is "imported" and the section 6 policy applies.
  iOS (simulator and dev-signed devices) uses `simctl` or `devicectl` file copy plus
  `automobile-proto://open`.
- `prototype save`: when ProtoViewer is installed and reachable, build a canonical bundle and route
  it as above; otherwise the CtrlProxy or template path is unchanged. The output gains `viewer`.
- `prototype open` (new action) launches a library id.
- Not in the first release: MCP `export` and `import` actions, a `listSaved` merge, live attach.

## 8. Distribution

Both platforms ship in the first release, from **GitHub releases only** (no Play Store or App Store
listing):

- Android: a signed APK as a release asset next to CtrlProxy, with a pinned checksum.
- iOS: dev-signed builds installed on the owner's iPhones (an Apple Developer team is configured).
  The simulator template remains available.

## 9. Phased plan

**First release.** Library list; open and switch; relaunch and reset; delete; share a clean bundle;
import by file or share sheet; MCP `save` routing and `open`; the global network switch; the shared
hardening work.
Not included: thumbnails, search, keep-both or replace, compact links, MCP export and import,
per-host consent, URL and QR import, universal links.

Order: (1) the corpus, strict zip reader and Swift reject-only validator, in parallel with (2) the
single Android extraction; then (3) the Android app, (4) the hardening module, (5) MCP routing,
(6) the iOS app.

**Phase 2.** Per-host consent UI, URL import (https only, with confirmation and the egress check on
the fetch), QR, thumbnails, search, replace and keep-both, font opt-in.
**Phase 3.** Store tracks, universal links, MCP export and import, live attach for imported
prototypes (off by default).

## 10. Test plan

Unit tests (fakes and FakeTimer, each under 100 ms): the strict zip reader (path handling,
duplicates, links, size and ratio limits, header-size mismatch, encryption, methods), `bundle.json`
strictness, the library index (a corrupt entry is skipped), id isolation and empty storage on import,
export rebuild (no storage, source or library fields) and the preflight scan, the egress check on
resolved addresses with a fake resolver (loopback, `10.0.2.2`, link-local, IPv6, redirect
re-check, https to http), forbidden headers, privileged-window rejection, the network switch,
import size gates, iOS pixel budget and magic bytes.

Corpus: the extended `test/fixtures/prototype-spec` run in TS, Kotlin and Swift, asserting accept or
reject plus error path only.

Device (manual-test skill; Android API 37 and iOS 27.x on the owner's iPhone): MCP save to library;
switch among three; relaunch; reset; delete; share and re-import across platforms; adb push plus
VIEW import; invalid-spec error; offline with stored values; a localhost request blocked and a LAN
request allowed with the switch on.

## 11. Risks

1. Swift validator parity is the critical path; mitigated by the reject-only scope and the corpus.
2. The network policy for library prototypes differs from the "no allowlist" behaviour of #12518;
   MCP-direct `show` flows are unchanged.
3. The extraction touches CtrlProxy; mitigated by one mechanical change and the existing suites.
4. The adb-based MCP channel is Android-specific; iOS uses `simctl` and `devicectl`.
5. With no `specVersion`, older apps reject newer specs; `requires` and capability messages soften
   this.

## 12. Decisions

| Question                   | Decision (owner, 2026-10-19)                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| iOS distribution           | Dev-signed builds on the owner's iPhones in the first release, alongside Android.                       |
| Network for imported specs | One global switch, default off; per-host consent in Phase 2; MCP-direct `show` keeps today's behaviour. |
| Stores                     | GitHub releases only.                                                                                   |
| LAN egress                 | RFC1918 LAN is allowed; loopback, link-local, `10.0.2.2` and the daemon ports stay blocked.             |
| MCP-saved prototypes       | Follow the imported-prototype network policy.                                                           |

## Issues

Epic #13625: #13616 bundle format, #13617 Android extraction, #13618 Android app, #13619 iOS app,
#13620 validation parity, #13621 MCP routing and `open`, #13622 shared hardening, #13623 release
and CI.
