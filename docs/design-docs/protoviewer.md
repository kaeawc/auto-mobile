# ProtoViewer: a prototype library app for iOS and Android

Status: accepted design for epic #13625. Owner request: a ProtoViewer app on iOS and Android to
switch between, relaunch, share, download, and view any prototype that is a valid AutoMobile JSON
SDUI spec.

## 1. Current state

**Spec and validation**

- Contract: `schemas/prototype-spec-contract.json` (limits, per-node field rules). Host validator
  and types: `src/features/prototype/prototypeSpec.ts` and `prototypeValidation.ts`. Kotlin twin:
  `PrototypeSpecValidator` in `android/protocol`. Swift's reject-only `PrototypeSpecStrictValidator`
  extends the generated structural interpreter from #14803 in `AutoMobilePrototypeAgentCore`.
  It composes the existing request, platform, state, check, repeat and resource-limit helpers with
  located host semantics. Unknown keys and malformed storage reject the whole spec. All three
  runtimes consume the complete shared valid/invalid corpus; there are no Swift exemptions.
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
#12518). That choice stands for MCP-direct flows; library prototypes need a pinned transport on
iOS (section 6).

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
and its renderer honours privileged window options. ProtoViewer declares `INTERNET` and the
runtime-granted `ACCESS_LOCAL_NETWORK` permission that Android 17 (API 37) requires for private LAN
connections, and nothing else (no accessibility, input method, overlay, device-admin or camera).
`ACCESS_LOCAL_NETWORK` is requested only when the user turns on "Allow network for imported
prototypes" (section 6), never at install or first launch; if it is denied, LAN requests fail with
the same typed error as a blocked host. The validator rejects `window.layer: "system"` and any other privileged window option for library prototypes.

- **Android renderer extraction is one mechanical move.** The `ctrlproxy/prototype` package imports
  only a few symbols from the rest of CtrlProxy, so moving it to a `:prototype-render` module
  (Compose plus `android/protocol`) is a rename plus three seams. CtrlProxy keeps
  `SavedPrototypeActivity` and shortcuts on top of the library (#13617).
- **iOS** links the existing `AutoMobilePrototypeAgent` SwiftPM library, as the current `Viewer`
  does. The per-prototype simulator template stays as "pin to home screen".

### 3.2 Validation parity (critical path)

Importing a prototype needs identical accept and reject behaviour on all three platforms:

1. `PrototypeSpecStrictValidator.validate(data:supportedCapabilities:library:)` accepts raw UTF-8
   `Data` and returns normally or throws `PrototypeLoadError.invalidSpec(path:message:)`. It extends
   `PrototypeContractValidator` and the generated `PrototypeSpecContractData.swift`; it does not
   replace the interpreter or return a render model. Existing runtime helpers supply request,
   platform, state binding, check grammar, repeat projection/binding and limit rules. Additional
   strict checks retain authored paths for cross-node targets, charts, storage and template scope.
2. All three corpus runners discover **every** `.json` in
   `test/fixtures/prototype-spec/{valid,invalid}` and compare their lists with `corpus.json`.
   The inventory also records TS-computed capabilities for every valid spec, asserted by all three.
   An added fixture without a refreshed inventory fails the ratchet in each runner. Capture with
   `bun scripts/capture-prototype-strict-fixtures.ts`: `expectedPath` comes from real TS output.
   Assertions compare acceptance and error path, never message text. Unknown-key cases cover each
   observed strict object rule; boundary cases exercise structural and data/expanded-tree budgets.
3. Valid fixtures remain ordinary specs. An invalid envelope contains `spec` or, when JSON cannot
   preserve the input, `rawJson` (duplicate keys, escaped surrogates, non-JSON tokens, nesting) or
   `rawBytesBase64` (invalid UTF-8), plus `expectedPath`. Optional `options` supplies `library` and
   `supportedCapabilities`. No additional fixture directory or binary assets are needed; the
   existing `.gitattributes` JSON rule pins LF.
4. Raw inputs allow one leading UTF-8 BOM. Duplicate keys (including escaped aliases), lone UTF-16
   surrogates, invalid UTF-8, nonfinite numeric tokens and more than 128 JSON containers reject at
   `$` before recursive decoding. The semantic tree/data depths remain 24/8. Finite numbers follow
   TS double semantics, including `-0` and values above 2^53; IDs keep the existing TS grammar
   without imposing an undocumented 256-character or Unicode-normalization restriction.
5. Capability computation is independent of the agent's advertised renderer support; supplying a
   capability set rejects missing features at `$`. `library: true` additionally rejects explicit
   system windows and device persistence at their window paths. Host validation continues to accept
   these options for CtrlProxy. Forbidden headers and literal CR/LF header values reject in every
   mode. Network routing and secure-binding import policy in section 5 still require the import
   boundary; this validator alone does not enable network access.
6. Import never partially renders or stores a failed spec. Element anchors are structurally valid;
   the existing embedded loader still requires host resolution to bounds (three corpus fixtures).
   Storage version/key _shape_ and declarations are validated here; persisted-version mismatch
   remains the existing storage restore/drop policy. Runtime-only caps (in-flight calls, response
   bytes, stack navigation and patch operations) are tested at their runtime boundaries rather than
   represented as invalid authored specs. The data-write pair is captured after a real TS write:
   data fits its own budget but its repeat expansion exceeds the node budget.

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
- Network: requests go through a pin-capable transport, not `URLSession`; App Transport Security is
  relaxed only in the simulator and dev build; see section 6.

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
- Not in the first release: user-facing URL import, universal links, compact `?spec=` links, QR. The
  one custom URL scheme in the first release is the internal launch scheme `automobile-proto://open`
  (section 7): the iOS app registers it, and it only opens an entry that is already in the library.
  It never fetches, imports or carries spec bytes.

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
   `window.layer: "system"` rejected, `secure` and `password` bindings into request URL, headers or
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
`request` actions fail with a typed error shown to the prototype (`statusKey` `error`). Per-host
consent is later work. MCP-direct `show` keeps today's behaviour. When on:

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
  `PrototypeNetworkConfiguration.pinned`. The ProtoViewer network switch stays unavailable on iOS
  until the app (#13619) wires it to that configuration; `URLSession` stays in use only for MCP-direct
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
  watchdog. Android sets `allowBackup=false` and allows no cleartext outside the dev flavor. iOS
  distributed (non-simulator) builds carry no App Transport Security exception.

The shared request-policy and storage work is tracked in #13622.

## 7. MCP integration (first release: save routing and open)

- Android uses adb, the existing device channel: the host pushes the bundle into ProtoViewer's
  app-scoped inbox directory and starts a non-exported internal import action (a separate
  component from the exported `ImportActivity`, see section 5 step 1) that names the inbox file. It
  runs the full import flow and the source is set by the app, never by the caller or the bundle, so
  the entry is "imported" and the section 6 policy applies. The exported `ImportActivity` keeps
  rejecting `file://` and its own authority, so a third-party app cannot reach the inbox route.
  iOS (simulator and dev-signed devices) uses `simctl` or `devicectl` file copy into the app's
  inbox plus the internal launch scheme `automobile-proto://open`, which the iOS app registers in
  the first release (section 4). Opening the scheme with an unknown id or an inbox name that does
  not pass the same import checks shows an error and changes nothing.
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
resolved addresses with a fake resolver and fake pinned transport (a second DNS answer is never
used; loopback, `10.0.2.2`, link-local, IPv6, redirect
re-check, https to http), forbidden headers, privileged-window rejection, the network switch,
import size gates, missing referenced image, font and manifest-entry bundles rejected, the MCP inbox
route rejected from the exported entry point, iOS pixel budget and magic bytes.

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
| iOS egress transport       | Network.framework (NWConnection) pinned transport (owner, 2026-10-21, #14540).                          |
| Missing referenced assets  | Recommended default, pending owner decision: reject the import on every platform.                       |
| Android LAN permission     | Recommended default, pending owner decision: declare `ACCESS_LOCAL_NETWORK`, request on switch-on.      |
| MCP-saved prototypes       | Follow the imported-prototype network policy.                                                           |

Rows marked "Recommended default, pending owner decision" are not yet owner-decided; they are the
defaults this document assumes until the owner answers.

## Issues

Epic #13625: #13616 bundle format, #13617 Android extraction, #13618 Android app, #13619 iOS app,
#13620 validation parity, #13621 MCP routing and `open`, #13622 shared hardening, #13623 release
and CI.
