# iOS Photos full access: establishing and verifying `PHAccessLevelReadWrite`

Status: host structured failure and injectable verification implemented (issue #12317);
simulator verification with the Playground probe is still owed. Nothing here is device-verified.
Related: #12316 (readback classification), #12368 (merged: Photos grants return
`verified:false` and readback `unknown`).

## Problem

`setAppPermissions` with `photos` on an iOS Simulator runs `simctl privacy <udid> grant photos <bundle>`
(`src/utils/ios-cmdline-tools/IosPermissionsBackend.ts`) and stores a `kTCCServicePhotos` row. The issue's controlled
matrix (iOS 26.5, Xcode 26.6) shows the app's own
`PHPhotoLibrary.authorizationStatus(for: .readWrite)` still reads `notDetermined` after that grant, and `.addOnly` only
becomes `authorized` after `photos-add`. The host now reports a dispatched Photos grant as a structured failure with
`success: false, applied: true, verified: false` and `code: "PHOTOS_FULL_ACCESS_UNVERIFIED"` by default
(`src/features/action/IosSimulatorPermissions.ts`, `classifyIosSimulatorPermission` and `verifyPhotosGrant`), and
`PhotosAuthorizationVerifier` is an injectable seam for target-app instrumentation. Only an `authorized` read/write
status yields verified success; `limited`, `denied`, and `notDetermined` return `PHOTOS_FULL_ACCESS_NOT_ESTABLISHED`.
An unobservable or throwing verifier returns `PHOTOS_FULL_ACCESS_UNVERIFIED`. Stored TCC grants remain evidence only.

No simulator/runtime combination is currently verified to give effective full access through `simctl privacy grant`.
Physical iOS device permission limits are unchanged.

## What the host can and cannot observe

Certain (Apple API facts):

- `PHPhotoLibrary.authorizationStatus(for:)` (iOS 14+) reports the status for the calling process's own app identity.
  `PHAuthorizationStatus` raw values: `notDetermined` 0, `restricted` 1, `denied` 2, `authorized` 3, `limited` 4.
- Querying the status does not show a prompt; only `requestAuthorization(for:handler:)` can.
- An app needs `NSPhotoLibraryUsageDescription` (read/write) and `NSPhotoLibraryAddUsageDescription` (add-only) in its
  Info.plist for a request to be legal; the status query does not need them.
- `XCUIApplication.resetAuthorizationStatus(for:)` can reset a protected resource of the target app, and the runner
  already uses it (`ios/control-proxy/Sources/CtrlProxy/GesturePerformer.swift:3163`, `.photos` for both
  `photos` and `photos-add`). XCUITest has no public API to read an authorization status for another app.

Repo evidence:

- The stored TCC rows are readable from the host (`src/utils/ios-cmdline-tools/SimulatorTccSqliteClient.ts:27-28` maps
  `photos` to `kTCCServicePhotos` and `photos-add` to `kTCCServicePhotosAdd`), but the issue shows a stored
  `auth_value=2` row is not the effective PhotoKit status, so the TCC row is not a verification channel.
- The runner mapping collapses `photos-add` onto `.photos` (`GesturePerformer.swift:655-657`), so (as `XCUIProtectedResource` itself has only `.photos`) it cannot distinguish
  the two access levels even for reset.

## Options

### A. Query authorization from the CtrlProxy / XCTest runner (rejected)

The runner is a separate process (`XCTRunner`) with its own bundle identity. `PHPhotoLibrary.authorizationStatus` called
there describes the runner, not the target app. Nothing in `ios/control-proxy/` can read the target's status; adding a
runner command would return a number that looks authoritative and is about the wrong app. Not recommended.
UNVERIFIED: whether the runner's own status tracks the target's on a simulator; do not rely on it.

### B. Instrumented probe app (recommended first step)

An app that links no SDK of ours (or the Playground) calls `authorizationStatus(for:)` for both access levels and
writes the raw values to its own `Documents/` as JSON. The host reads it through `simctl get_app_container <udid>
<bundle> data`, the channel already used by `src/server/appFileService.ts:1783` and the SDK-free probe pattern in
`ios/UserDefaultsProbe/Probe.swift` + `scripts/ios/userdefaults-no-sdk-smoke.sh`. This is the only approach that observes
real PhotoKit state, but it observes the PROBE app, not an arbitrary target app. It therefore proves what a grant
sequence does on a given simulator/runtime/Xcode combination (the issue's acceptance criteria for an independent probe
and for cold-restart persistence) and can anchor a support matrix. It cannot make `setAppPermissions` report `verified:
true` for an app that did not ship the probe.

The existing `ios/Playground/Sources/PhotosAuthorizationProbe.swift` writes
`Documents/photos-authorization.json` at launch with fields `readWrite` and `addOnly` (each `{ rawValue, name }`) plus
`observedAt`; the Playground Info.plist gains the two Photos usage-description keys. It never calls
`requestAuthorization`.

### C. In-app SDK status for integrated target apps (follow-up)

The iOS SDK (`ios/auto-mobile-sdk`) already runs inside integrated apps and has host-readable inspection channels. A
`PhotosAuthorizationInspector` could publish the same JSON from the real target. Then `verifyPhotosGrant` could return
`verified: true` only when the snapshot is fresh and `readWrite.name == "authorized"`. Cost: SDK API surface, a freshness
rule (the snapshot is only as new as the last app launch/foreground), and it only helps SDK apps. Not implemented.

### D. Different TCC writes (needs device experiments)

Hypotheses, all UNVERIFIED and not attempted:

- Inserting `kTCCServicePhotos` with `auth_value=3` (limited) or `kTCCServicePhotosAdd` with other values directly into
  the simulator `TCC.db` rather than via `simctl privacy`. The issue shows `auth_value=2` stored but not effective, which
  suggests PhotoKit (via `photolibraryd`) keeps authorization state that the TCC row alone does not set; a raw write is
  unlikely to differ.
- Granting after the first launch or after a `photolibraryd` restart instead of before first launch (the issue only
  tested grants before the first launch).
- Names for iOS 17+: the repo maps only `kTCCServicePhotos` and `kTCCServicePhotosAdd`; whether newer runtimes use
  additional service names is unknown here.

Run these with the probe from option B on a dedicated simulator before changing any host code. Writing TCC.db is also
not a supported interface and may break between runtimes.

## Recommended path

1. Use option B's existing probe so the experiments in D and the cold-restart check have an independent reader.
2. `setAppPermissions` now returns a structured `PHOTOS_FULL_ACCESS_UNVERIFIED` failure after dispatch by default,
   with `applied: true`, `verified: false`, and instructions to launch the app and check
   `PHPhotoLibrary authorizationStatusForAccessLevel:ReadWrite`. Add-only is insufficient and `photos-add` remains
   a separate dispatch success. `getAppPermissions` still classifies a stored Photos grant as `unknown`,
   `verified: false`, with `evidence: "storedTccGrant"`.
3. Verify a sequence with the Playground probe before claiming support for any simulator/runtime range. No such
   combination is currently verified. The host keeps returning a structured failure without target-app instrumentation;
   its injectable verifier can report `verified: true` only for an `authorized` read/write status. A `limited`,
   `denied`, or `notDetermined` status returns `PHOTOS_FULL_ACCESS_NOT_ESTABLISHED` instead of a warning.
4. Option C for SDK-integrated apps to allow a real `verified: true`.

## Device checks owed

- Build and launch the Playground on a dedicated simulator; confirm `photos-authorization.json` appears with
  `notDetermined` for both levels on a fresh install.
- Repeat the issue's grant matrix against the Playground and record `readWrite`/`addOnly` per sequence, plus a cold
  restart after the best sequence.
- Try grant-after-launch and a raw TCC write (option D); record the Xcode and runtime versions.

## Implied add-only readback (#12462)

The inference from a full `kTCCServicePhotos` grant (`auth_value` 2) to `photos-add` applies only on
simulator runtime major >= 27 (threshold ORCHESTRATOR-CHOSEN, issue #12486). The 27.0 capture in
`test/fixtures/ios-tcc-photos/` shows add-only `authorized` even with a stale PhotosAdd row; the iOS
26.5 fixture set shows it does not: PhotoKit addOnly is `notDetermined` after reset+grant photos and
`denied` after revoke+grant photos. Runtime version comes from `device.iosVersion` or
`device.osVersion`; with an unknown runtime, readback reports the stored PhotosAdd row. Gating on the
Photos row's `auth_version` was considered (27.0 wrote 2, 26.5 wrote 1) and rejected as too indirect
and undocumented.
