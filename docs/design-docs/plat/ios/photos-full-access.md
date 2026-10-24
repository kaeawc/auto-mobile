# iOS Photos full access: establishing and verifying `PHAccessLevelReadWrite`

Status: non-fatal unverified success, typed observed failure and an injectable verifier are implemented
(#12317). Simulator verification with the Playground probe is still owed; nothing here is
device-verified. Related: #12316 (readback classification), #12368 (Photos grants return
`verified:false`, readback `unknown`).

## Problem

`setAppPermissions` with `photos` on a simulator runs `simctl privacy <udid> grant photos <bundle>`
(`src/utils/ios-cmdline-tools/IosPermissionsBackend.ts`) and stores a `kTCCServicePhotos` row. The
issue's controlled matrix (iOS 26.5, Xcode 26.6) shows the app's own
`PHPhotoLibrary.authorizationStatus(for: .readWrite)` still `notDetermined` after that grant, and
`.addOnly` becomes `authorized` only after `photos-add`. No simulator/runtime combination is verified to
give effective full access through `simctl privacy grant`. Physical-device limits are unchanged.

Host outcomes (`src/features/action/IosSimulatorPermissions.ts`, `classifyIosSimulatorPermission`,
`verifyPhotosGrant`; `PhotosAuthorizationVerifier` is an injectable seam for target-app
instrumentation):

| Observation                                                         | Result                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default (dispatched, unobservable), or verifier/TCC-readback throws | `success: true, applied: true, verified: false`, warning, `code: "PHOTOS_FULL_ACCESS_UNVERIFIED"`; counts as changed; warnings aggregate in `warnings`; exceptions logged at warn; a readback exception returns this before consulting the verifier |
| `authorized` read/write                                             | Verified success, no code or warning                                                                                                                                                                                                                |
| Positive `limited`, `denied`, `notDetermined`, `addOnly`            | Typed failure `PHOTOS_FULL_ACCESS_NOT_ESTABLISHED`, `applied: true`, `verified: false`, `accessLevel: "readWrite"`, actionable error                                                                                                                |

For `all`, a confirmed Photos failure keeps the successful `all` dispatch (`applied: true`) and adds a
separate failed `photos` result; non-Photos services are not marked failed, only Photos increments
`failedCount`, and the top-level error is the first failed result's. The facade maps each result to its
own operation with a permission-specific `stepId` and exposes its code. `getAppPermissions` still
classifies a stored Photos grant as `unknown`, `verified: false`, `evidence: "storedTccGrant"`; stored
TCC grants are evidence only.

## What the host can and cannot observe

Apple API facts:

- `PHPhotoLibrary.authorizationStatus(for:)` (iOS 14+) reports the calling process's own identity.
  Raw values: `notDetermined` 0, `restricted` 1, `denied` 2, `authorized` 3, `limited` 4.
- Querying never prompts; only `requestAuthorization(for:handler:)` does. A request needs
  `NSPhotoLibraryUsageDescription` (read/write) / `NSPhotoLibraryAddUsageDescription` (add-only); the
  status query needs neither.
- `XCUIApplication.resetAuthorizationStatus(for:)` can reset a protected resource; the runner uses it
  (`ios/control-proxy/Sources/CtrlProxy/GesturePerformer.swift`, `.photos` for both `photos` and
  `photos-add`, since `XCUIProtectedResource` has only `.photos`, so it can't distinguish the levels).
  XCUITest has no public API to read another app's authorization status.

Repo evidence: stored TCC rows are host-readable (`SimulatorTccSqliteClient.ts` maps `photos` to
`kTCCServicePhotos`, `photos-add` to `kTCCServicePhotosAdd`), but a stored `auth_value=2` row is not the
effective PhotoKit status, so TCC is not a verification channel.

## Options

- **A. Query from the CtrlProxy/XCTest runner (rejected).** The runner is a separate process
  (`XCTRunner`) with its own bundle identity; its status describes the runner, not the target, so a
  runner command would return an authoritative-looking number about the wrong app. Unverified whether the
  runner's status tracks the target's on a simulator; don't rely on it.
- **B. Instrumented probe app (recommended first step).** An app without our SDK (or the Playground)
  calls `authorizationStatus(for:)` for both levels and writes raw values to its own `Documents/` as
  JSON; the host reads it via `simctl get_app_container <udid> <bundle> data` (the channel used by
  `src/server/appFileService.ts` and the SDK-free probe pattern `ios/UserDefaultsProbe/Probe.swift` +
  `scripts/ios/userdefaults-no-sdk-smoke.sh`). It observes real PhotoKit state but of the PROBE app, so
  it proves what a grant sequence does per simulator/runtime/Xcode (independent probe, cold-restart
  persistence) and can anchor a support matrix, but cannot make `setAppPermissions` report
  `verified: true` for an app that didn't ship it. The existing
  `ios/Playground/Sources/PhotosAuthorizationProbe.swift` writes `Documents/photos-authorization.json`
  at launch (`readWrite` and `addOnly`, each `{ rawValue, name }`, plus `observedAt`); the Playground
  Info.plist gains both usage-description keys. It never calls `requestAuthorization`.
- **C. In-app SDK status for integrated apps (follow-up, not implemented).** A
  `PhotosAuthorizationInspector` in `ios/auto-mobile-sdk` could publish the same JSON from the real
  target, letting `verifyPhotosGrant` return `verified: true` when the snapshot is fresh (only as new as
  the last launch/foreground) and `readWrite.name == "authorized"`. Costs SDK API surface; helps only SDK
  apps. A real `PhotosAuthorizationVerifier` needs this; the production default stays unobservable.
- **D. Different TCC writes (all UNVERIFIED, not attempted).** Direct `TCC.db` inserts
  (`kTCCServicePhotos` `auth_value=3`, `kTCCServicePhotosAdd` other values) are unlikely to differ since
  `photolibraryd` seems to keep state the TCC row doesn't set, and `TCC.db` writes are unsupported and may
  break between runtimes; granting after first launch or after a `photolibraryd` restart (the issue only
  tried before first launch); additional service names on iOS 17+ (the repo maps only the two). Run
  these with the option B probe on a dedicated simulator before changing host code.

## Recommended path

1. Use the option B probe as the independent reader for D and the cold-restart check.
2. Default to non-fatal `PHOTOS_FULL_ACCESS_UNVERIFIED` after dispatch, with a warning to launch the app
   and check `PHPhotoLibrary authorizationStatusForAccessLevel:ReadWrite`. Add-only is insufficient;
   `photos-add` remains a separate dispatch success.
3. Verify a sequence with the Playground probe before claiming support for any simulator/runtime range.
4. Option C for SDK-integrated apps to allow a real `verified: true`.

## Device checks owed

- Build/launch the Playground on a dedicated simulator; confirm `photos-authorization.json` shows
  `notDetermined` for both levels on a fresh install.
- Repeat the issue's grant matrix against it, recording `readWrite`/`addOnly` per sequence plus a cold
  restart after the best one.
- Try grant-after-launch and a raw TCC write (D); record Xcode and runtime versions.

## Implied add-only readback (#12462)

Inferring `photos-add` from a full `kTCCServicePhotos` grant (`auth_value` 2) applies only on simulator
runtime major >= 27 (threshold ORCHESTRATOR-CHOSEN, #12486). The 27.0 capture in
`test/fixtures/ios-tcc-photos/` shows add-only `authorized` even with a stale PhotosAdd row; the iOS 26.5
set shows PhotoKit addOnly `notDetermined` after reset+grant photos and `denied` after revoke+grant
photos. Runtime version comes from `device.iosVersion` or `device.osVersion`; with an unknown runtime,
readback reports the stored PhotosAdd row. Gating on the Photos row's `auth_version` (27.0 wrote 2, 26.5
wrote 1) was rejected as too indirect and undocumented.
