# ProtoViewer: a prototype library app for iOS and Android

ProtoViewer is a standalone app on iOS and Android to switch between, relaunch, share, download
and view any prototype that is a valid AutoMobile JSON SDUI spec (epic #13625).

Sections 4 to 8 are on their own pages:

- [4. Data model and formats; 5. Import validation flow](protoviewer-data-model.md)
- [6. Network policy and limits; 7. MCP integration](protoviewer-network-mcp.md)
- [8. Distribution](protoviewer-distribution.md)

## 1. Overview

- **Spec and validation.** Contract `schemas/prototype-spec-contract.json`; host validator
  `src/features/prototype/prototypeSpec.ts` / `prototypeValidation.ts`; Kotlin twin
  `PrototypeSpecValidator` (`android/protocol`); Swift reject-only `PrototypeSpecStrictValidator`
  (see [iOS prototype agent](plat/ios/prototype-agent.md)). All three consume the shared
  valid/invalid corpus with no exemptions. Unknown keys and malformed storage reject the whole spec.
- **Envelope** `{ id, window, data?, state?, motion?, storage?, theme?, root }`. There is **no
  `specVersion`**: older and newer shapes are rejected, never migrated (see
  [Android prototype specification](plat/android/prototype-ux.md)). Evolution is by device
  capabilities (`PROTOTYPE_SPEC_CAPABILITY_GATES` in `prototypeCapabilityGates.ts`).
- **Limits:** 1 MiB spec, 2000 nodes and 32 images per stack screen (10000 and 160 per spec), depth 24, data 256 KiB, storage 64 keys / 256 KiB,
  4 requests in flight, 30 s timeout. `readPrototypeSpecFile` does stat-then-read size caps, BOM strip
  and JSON parse for `specPath`.
- **Showing from a host.** MCP `prototype` tool (`src/server/prototypeTools.ts`): `show` (inline
  `spec` or host-side `specPath`), `patch`, `dismiss`, `status`, `inspect`, `awaitEvent`, `save`,
  `listSaved`, `deleteSaved`, `clearStorage`. Android: CtrlProxy Compose overlay
  (`ctrlproxy/prototype/*`, `androidPrototypeTransport.ts`). iOS simulator: injected dylib
  `ios/prototype-agent`.
- **Saved prototypes without ProtoViewer.** Android: `SavedPrototypeStore` /
  `SavedPrototypeDirectoryStore` (app-private slug dirs, manifest last, content-hash assets, max
  50), `SavedPrototypeActivity` (one document task per id, not exported), pinned shortcuts, per-id
  storage under `filesDir/prototype-storage/`, all inside the CtrlProxy APK. iOS: per-prototype app
  copy of `ios/prototype-agent/Viewer` installed by `iosPrototypeInstaller.ts`, spec at
  `Documents/prototype/{manifest.json,spec.json,assets,fonts}` (formatVersion 1, one per
  container), template `AutoMobilePrototypeViewer.zip` from `build-prototype-viewer.yml`, simulator
  only. Shared layout code in `savedPrototypeLayout.ts` and Swift with fixture
  `test/fixtures/prototype-saved-layout/layout.json`.
- **Data and network.** `request` with `via: host|device` (Retrofit on Android, `URLSession` on
  iOS) serves MCP-direct flows; library prototypes use a pinned iOS transport (section 6).

## 2. Scope

ProtoViewer keeps a library (names, last opened, one-tap switch), relaunches (restart from the
spec) and resets (relaunch plus clearing that prototype's storage), shares a clean validated
`.automobile-proto` bundle, imports by file open or share-sheet receive with path-naming validation
errors, renders offline with the existing renderers (saved storage and `via: "device"` requests
included), takes MCP `save` into the library and `open` from an agent, and looks native on each
platform (Material 3 on Android, SF Symbols on iOS).

Out of scope: spec migration or a `specVersion`, an editor, cloud sync or accounts, a sharing
service, and running arbitrary code (specs stay declarative).

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
the library explains that network access is disabled until permission is granted. The validator rejects `window.layer: "system"` and any other privileged window
option for library prototypes.

- **Android** renders with the renderer extracted from CtrlProxy into its own module (Compose plus
  `android/protocol`). CtrlProxy keeps `SavedPrototypeActivity` and shortcuts on top of that
  library (#13617).
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

- `minSdk` is 26; the bundle commit relies on `java.nio` NOFOLLOW checks and atomic same-volume moves.
- Application ID `dev.jasonpearson.automobile.protoviewer` for release builds; the debug build adds
  `.dev`, so a dev build never shares an ID with a store build. The namespace (and every class and MCP
  action name) stays `dev.jasonpearson.automobile.protoviewer` in both. `LibraryActivity` is the launcher list,
  `ViewerActivity` is a document task per prototype (not exported), and an exported `ImportActivity`
  handles VIEW and SEND for `content://` data only.
- Storage reuses the `SavedPrototypeDirectoryStore` layout, keyed by an **app-generated library
  id** (a UUID from `IdGenerator`), never `spec.id`. `allowBackup=false` and
  `dataExtractionRules` exclude the library. The prototype storage file name derives from the
  library id.
- Relaunch finishes the task and starts `ViewerActivity` again. Reset is relaunch plus clearing that
  library id's storage. Delete removes the metadata first (it is the visibility marker), then the
  storage, spec and assets. On Android an app-start sweep deletes any saved bundle with no metadata
  directory, which finishes a delete that failed after the metadata went and an add interrupted
  before its metadata commit; it aborts without deleting anything when metadata cannot be listed,
  and keeps a bundle whose metadata exists but is unreadable.
- Share rebuilds a clean bundle (section 4) and hands it out through a `FileProvider` scoped to an
  export-cache subdirectory, with a read-only temporary grant and the temp file deleted afterwards.
- Fonts and images decode off the main thread.
- **Copy diagnostics** in the viewer toolbar puts plain text on the clipboard: app version, Android
  SDK level, the renderer capability set, the last failure as a fixed code (`validation`,
  `storage-load`, `render`, `watchdog` or `library-<error>`) and whether the render watchdog tripped.
  `ViewerDiagnostics` has no field for spec text, validator paths or messages, labels, library ids,
  saved state or requests, so none can be copied; `ViewerDiagnosticsTest` asserts this.

### 3.4 iOS app

- Both `Info.plist` files (ProtoViewer and the Viewer template) declare `UIDeviceFamily` `[1, 2]` and all four
  iPad orientations, so the app runs natively on iPad instead of in iPhone compatibility mode. Multiple
  scenes stay off. The artifact policy gate and privacy manifest do not constrain the device family.
- SwiftUI `ProtoViewer`: `LibraryView` (SF Symbols only) and `PrototypeScreen` hosting
  `ViewerRenderer` with `PrototypeModel(mode: .standalone, storage: .fileBacked())` in a
  per-library-id namespace.
- ProtoViewer's own chrome keys on the native horizontal size class (compact or regular; no Material
  breakpoints). `LibraryView` is one `NavigationSplitView` at every width: regular (full iPad window,
  iPhone Duo inner panel) shows the library as a sidebar beside the open prototype, compact collapses to
  the phone stack. The selection is plain state, so a size-class change (iPad window resize, Duo fold or
  unfold) keeps the open prototype mounted; deleting the open entry clears the detail pane. Settings,
  licenses and error text cap at a readable width at regular size. The prototype itself still sizes from
  its own window, and the app-reserved chrome (toolbar, network indicator) stays outside it.
- Data lives in Application Support (not Documents, no `UIFileSharingEnabled`) with
  `isExcludedFromBackup` set. Each prototype directory is `PrototypeSavedLayout` formatVersion 1,
  unchanged, plus the sibling `library.json` (section 4).
- Bundle ID `dev.jasonpearson.automobile.protoviewer`. `scripts/ios/protoviewer-build.sh` adds `.dev`
  when it compiles the cleartext opt-in (its default); release-style builds (`PROTOVIEWER_CLEARTEXT=0`)
  keep the store ID, which the artifact policy gate checks.
- Import uses `fileImporter` and `onOpenURL` (document UTI `dev.jasonpearson.automobile.prototype`).
  Image decode has a pixel budget and a PNG/JPEG/WebP magic-byte allowlist before `UIImage(data:)`.
  Fonts are unregistered when switching prototypes.
- **Copy diagnostics** in the viewer actions menu copies plain text with fixed, unlocalized keys:
  app version, iOS version, sorted renderer capabilities, the last fixed failure code and whether
  the render watchdog tripped. `ViewerDiagnostics` in Core has no field for spec text, validator
  paths or messages, labels, library ids, saved state or requests. Library load failures use
  `library-corrupt`, storage opening uses `storage-load`, metadata/reset failures use `library-storage`,
  renderer validation uses `validation`, and watchdog expiry uses `watchdog`. The watchdog flag stays
  true for the open screen even after relaunch. Core tests cover formatting and content exclusion.
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
  fails when a bundled dependency has no license entry or no license text.
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

## 10. Tests

Unit tests use fakes and FakeTimer and stay under 100 ms. They cover the strict zip reader (paths,
duplicates, links, size and ratio limits, header-size mismatch, encryption, methods), `bundle.json`
strictness, the library index (a corrupt entry is skipped), id isolation and empty storage on
import, export rebuild (no storage, source or library fields) and the preflight scan, the egress
check on resolved addresses with a fake resolver and fake pinned transport (a second DNS answer is
never used; loopback, `10.0.2.2`, link-local, IPv6, redirect re-check, https to http), forbidden
headers, privileged-window rejection, the network switch, import size gates, bundles missing a
referenced image, font or manifest entry, the MCP inbox route rejected from the exported entry
point, and the iOS pixel budget and magic bytes. The spec corpus `test/fixtures/prototype-spec`
runs in TS, Kotlin and Swift (accept/reject plus error path only).

Import fuzzing (#14159): `scripts/prototype/bundleFuzz.ts` holds seeded generators (byte mutation, hostile
ZIP structure, hostile `bundle.json`/`spec.json`, DEFLATE bombs). They feed fast-check property tests in
TS (`prototypeBundleFuzz.property.test.ts`, unit budget) and a wider sweep (`.integration.test.ts`, safe
tier). `test/fixtures/prototype-bundle/fuzz-corpus.json` is the shared differential corpus: TS records the
verdict (accept, or code plus path) and the Kotlin (`PrototypeBundleFuzzTest`) and Swift
(`PrototypeBundleFuzzTests`) readers must reproduce it, alongside seeded per-platform mutation sweeps that
assert only typed rejections. Regenerate with `bun scripts/prototype/generate-bundle-fuzz-corpus.ts
--write`; a minimized finding becomes a fixture in `corpus.json`.

## Background

- [ProtoViewer design decisions](../devlog/2026-10-20-protoviewer-design.md)
- [ProtoViewer open-source notice generators](../devlog/2026-10-25-protoviewer-open-source-notices.md)
- [fastlane supply for ProtoViewer Google Play publishing](../devlog/2026-11-03-fastlane-supply-play-publishing.md)
