# iOS Photos full access: establishing and verifying `PHAccessLevelReadWrite`

`setAppPermissions` with `photos` on a simulator runs `simctl privacy <udid> grant photos <bundle>`
(`src/utils/ios-cmdline-tools/IosPermissionsBackend.ts`), which stores a `kTCCServicePhotos` row.
That grant is not known to give the app effective full access: on iOS 26.5 / Xcode 26.6 the app's own
`PHPhotoLibrary.authorizationStatus(for: .readWrite)` stays `notDetermined`, and `.addOnly` becomes
`authorized` only after `photos-add` (#12317). No simulator/runtime combination is verified, and
nothing here is device-verified. Physical-device limits are unchanged.

## Grant outcomes

Implemented in `src/features/action/IosSimulatorPermissions.ts` (`classifyIosSimulatorPermission`,
`verifyPhotosGrant`). `PhotosAuthorizationVerifier` is an injectable seam for target-app
instrumentation; the production default is unobservable.

| Observation                                                         | Result                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default (dispatched, unobservable), or verifier/TCC-readback throws | `success: true, applied: true, verified: false`, warning, `code: "PHOTOS_FULL_ACCESS_UNVERIFIED"`; counts as changed; warnings aggregate in `warnings`; exceptions logged at warn; a readback exception returns this before consulting the verifier |
| `authorized` read/write                                             | Verified success, no code or warning                                                                                                                                                                                                                |
| Positive `limited`, `denied`, `notDetermined`, `addOnly`            | Typed failure `PHOTOS_FULL_ACCESS_NOT_ESTABLISHED`, `applied: true`, `verified: false`, `accessLevel: "readWrite"`, actionable error                                                                                                                |

- The unverified warning tells the user to launch the app and check
  `PHPhotoLibrary authorizationStatusForAccessLevel:ReadWrite`. Add-only is insufficient; `photos-add`
  is a separate dispatch success.
- For `all`, a confirmed Photos failure keeps the successful `all` dispatch (`applied: true`) and adds
  a separate failed `photos` result. Non-Photos services are not marked failed, only Photos increments
  `failedCount`, and the top-level error is the first failed result's.
- The facade maps each result to its own operation with a permission-specific `stepId` and exposes
  its code.
- `getAppPermissions` classifies a stored Photos grant as `unknown`, `verified: false`,
  `evidence: "storedTccGrant"` (#12316, #12368); stored TCC grants are evidence only.

## What the host can observe

- `PHPhotoLibrary.authorizationStatus(for:)` (iOS 14+) reports the calling process's own identity.
  Raw values: `notDetermined` 0, `restricted` 1, `denied` 2, `authorized` 3, `limited` 4.
- Querying never prompts; only `requestAuthorization(for:handler:)` does. A request needs
  `NSPhotoLibraryUsageDescription` (read/write) / `NSPhotoLibraryAddUsageDescription` (add-only); the
  status query needs neither.
- The CtrlProxy runner resets authorization with `XCUIApplication.resetAuthorizationStatus(for:)`
  (`ios/control-proxy/Sources/CtrlProxy/GesturePerformer.swift`), using `.photos` for both `photos`
  and `photos-add`: `XCUIProtectedResource` has only `.photos`, so it cannot distinguish the levels.
  XCUITest has no public API to read another app's authorization status, and the runner's own status
  describes the runner process, not the target.
- Stored TCC rows are host-readable (`SimulatorTccSqliteClient.ts` maps `photos` to
  `kTCCServicePhotos`, `photos-add` to `kTCCServicePhotosAdd`), but a stored `auth_value=2` row is not
  the effective PhotoKit status, so TCC is not a verification channel.

## Playground probe

`ios/Playground/Sources/PhotosAuthorizationProbe.swift` writes `Documents/photos-authorization.json`
at launch: `readWrite` and `addOnly`, each `{ rawValue, name }`, plus `observedAt`. It never calls
`requestAuthorization`. The Playground Info.plist has both usage-description keys. The host reads the
file with `simctl get_app_container <udid> <bundle> data` (the channel `src/server/appFileService.ts`
uses; same pattern as `ios/UserDefaultsProbe/Probe.swift` and
`scripts/ios/userdefaults-no-sdk-smoke.sh`). It reports the probe app's state, so it can establish
what a grant sequence does per simulator/runtime/Xcode but cannot make `setAppPermissions` report
`verified: true` for another app.

## Implied add-only readback

Readback infers `photos-add` from a full `kTCCServicePhotos` grant (`auth_value` 2) only on simulator
runtime major >= 27 (#12462, #12486). Runtime version comes from `device.iosVersion` or
`device.osVersion`; with an unknown runtime, readback reports the stored PhotosAdd row. Fixtures are in
`test/fixtures/ios-tcc-photos/`: the 27.0 capture shows add-only `authorized` even with a stale
PhotosAdd row; the iOS 26.5 set shows PhotoKit addOnly `notDetermined` after reset+grant photos and
`denied` after revoke+grant photos.

## Background

- [Verifying iOS Photos full access](../../../devlog/2026-10-15-photos-full-access-verification.md)
