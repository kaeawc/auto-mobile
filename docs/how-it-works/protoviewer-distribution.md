# ProtoViewer: distribution

Part of [ProtoViewer](protoviewer.md).

Both platforms ship from GitHub releases. Android also has a Google Play pipeline (section 8.3);
there is no App Store pipeline yet:

- Android: a signed APK as a release asset next to CtrlProxy, with a pinned checksum. Prepare Release
  builds it (`build-protoviewer-apk.yml`, release keystore, fail-closed signing), pins it as
  `protoViewerApkSha256` in `src/constants/release.ts`, and Release checks it against
  `RELEASE_CHECKSUM_REGISTRY` before publishing `automobile-protoviewer-<version>.apk` plus a
  `.sha256`; see [Installing ProtoViewer](../using/protoviewer-install.md).
- iOS: the simulator template remains available. A physical-iPhone build is not part of the release
  yet: the Apple Developer signing certificate and provisioning profile are not configured as
  repository secrets.

## 8.1 Release-artifact policy gate (#14154)

The hardening promises above are checked on the **built artifact**, not the source manifests, by
`scripts/release/check-protoviewer-artifact-policy.ts` against the checked-in allowlists in
`scripts/release/protoviewer-artifact-policy.json`:

- **Android** (`aapt2 dump xmltree` of the APK's merged manifest):
  - permissions equal the allowlist (`INTERNET`, `ACCESS_LOCAL_NETWORK`) with no declared
    permissions;
  - no `debuggable`;
  - `allowBackup=false` and `dataExtractionRules`;
  - no cleartext (`usesCleartextTraffic` or a network security config that permits it);
  - the exported components equal the allowlist (the launcher, `ImportActivity`, and the two
    `DUMP`-protected entries);
  - `targetSdk` at the Play floor;
  - no `-SNAPSHOT` `versionName` (local and PR builds pass `--allow-snapshot`).
- **iOS** (`plutil`, `codesign -d --entitlements`, `nm`):
  - no ATS relaxation and no `UIFileSharingEnabled`;
  - `CFBundleSupportedPlatforms` matches `--platform`;
  - entitlements within the allowlist and never a `get-task-allow` that is not `false`. Simulator
    builds keep entitlements in the executable, so `codesign` reports none and these rules bite on
    the device `.ipa`;
  - no `.dSYM` in the bundle and no debug map left in the executable.

  The `PrivacyInfo.xcprivacy` check is enforced (#14151, #15387). The
  forbidden-symbol check (`PrototypeServer`, `bootViewerHost`) is **advisory** (reported as a warning,
  table `advisory` in the policy file) until the App Store archive (#14150) lands; delete the table
  entry then to enforce it.

It runs in the pull-request Android build, in `prepare-release.yml` through
`verify-protoviewer-artifact-policy.yml` (which `verify-prepared-release` waits on), and locally with
`scripts/release/protoviewer-artifact-policy.sh`. Fixtures are real tool output captured by
`scripts/release/capture-protoviewer-policy-fixtures.sh`; CtrlProxy's release APK is the
deliberately failing Android case.

## 8.1.1 Device checks for release artifacts (#15387)

Release checks need a device and run from `scripts/release/protoviewer-release-smoke.sh` (logic in
`scripts/release/protoviewer-release-smoke.ts`, fake-tested in `test/scripts/protoviewerReleaseSmoke.test.ts`):

- **Upgrade in place** (`--mode upgrade`): install the previous release, import a prototype through
  the MCP inbox, and install the candidate over it (`adb install -r` / `simctl install`, never an
  uninstall). Then check the version moved and the app's data identity is unchanged (Android
  `firstInstallTime`, iOS data container path). The saved entry must still open under the same
  library id.
- **Minified smoke** (`--mode smoke`): install the R8-minified APK (`--build` passes
  `-Pautomobile.protoviewer.minifyRelease=true`) or the stripped iOS release. Import and open two
  validated asset-free specs, and on Android read the library screen's settings switch and open
  "Open-source licenses" through `uiautomator dump`.

- **iPhone Duo** (`--duo`, iOS only): after the normal flows install the candidate, import and
  open the smoke bundle in each posture. The `--posture-command <executable>` receives `closed` or
  `opened` directly (no shell); exit 0 means the posture is reached. The caller supplies daemon
  session wiring because simctl cannot change posture. Each screenshot explicitly selects the
  enumerated display name: `primary` for the closed cover and `primary-1` for the opened inner
  panel. Missing displays and posture failures are failed checks. PNGs are written and checked
  for a PNG signature under `--screenshots-dir` (default `scratch/protoviewer-smoke/duo`, relative
  to the current working directory). Fold-back to `closed` is always attempted and reported,
  including after a failed posture command.

Not automated: settings persistence (the network switch needs a runtime permission grant), and the
iOS Settings and licenses screens (no UI driver in the script); the script reports both as `SKIPPED`.
The candidate's key must sign the previous APK. `protoviewer-release-smoke.yml` is a
manual, advisory Android lane that downloads the previous release's APK; it is not called from any
release workflow. All of this is unverified on devices until someone runs it (label
`needs-device-verify` on #15387). The iOS forbidden-symbol rule stays advisory until #14150 lands.

## 8.2 Android release signing and versioning (#14146)

The shared release keystore signs the GitHub release APK, the same as CtrlProxy, through
`PROTOVIEWER_*` inputs mapped from the shared `RELEASE_*` secrets. This key is permanent for the
package's update path: moving to its own key or a Play upload key (#14146) requires uninstalling the
existing app first. The build derives its `versionCode` from the release version as described below.
Updates across releases need strictly increasing codes, which the derived scheme provides.

### Play-ready artifact configuration

The Android module builds a Play-uploadable AAB next to the APK. The Gradle side is the
`automobile.protoviewer-play-release` convention in `android/build-logic`; it replaces the shared
`automobile.android-app-signing` for ProtoViewer, which falls back open to the debug key.

**Release keystore inputs.** The convention reads inputs from the environment (CI) or
`gradle.properties` (local). `build-protoviewer-apk.yml` sets the `PROTOVIEWER_*` inputs at job level
using the shared release keystore secrets and the required `release-version` input, supplied by
`prepare-release.yml` from `inputs.version`. The `gradle-task-run` action decodes
`RELEASE_KEYSTORE_BASE64` into the keystore file under the Gradle project directory; no dedicated ProtoViewer keystore
secrets are wired.

| Input                                 | Purpose                                                   | CI source                                              |
| ------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| `PROTOVIEWER_KEYSTORE_PATH`           | keystore file (relative paths resolve against `android/`) | workflow env: the workspace path of that keystore file |
| `PROTOVIEWER_KEYSTORE_PASSWORD`       | store password                                            | `RELEASE_KEYSTORE_PASSWORD` secret                     |
| `PROTOVIEWER_KEY_ALIAS`               | key alias                                                 | `RELEASE_KEY_ALIAS` secret                             |
| `PROTOVIEWER_KEY_PASSWORD`            | key password                                              | `RELEASE_KEY_PASSWORD` secret                          |
| `PROTOVIEWER_RELEASE_VERSION`         | plain `MAJOR.MINOR.PATCH` of the release tag              | required `release-version` workflow input              |
| `PROTOVIEWER_REQUIRE_RELEASE_SIGNING` | `true` in release workflows: fail closed                  | workflow env: `true`                                   |

Whether the key is the Play upload key or the app-signing key is decided at Play App Signing
enrolment; record it next to the key.

**Fail closed.** The release workflow sets `PROTOVIEWER_REQUIRE_RELEASE_SIGNING=true`, so a release
assemble without complete signing inputs fails instead of falling back to the debug key. The
`verifyProtoViewerReleaseInputs` task
(a `preReleaseBuild` dependency, so it fails before compilation) rejects a missing signing input, a
missing keystore file, a missing `PROTOVIEWER_RELEASE_VERSION`, or a `-SNAPSHOT`/suffixed version.
Local and pull-request builds without `PROTOVIEWER_RELEASE_VERSION` stay debug-signed and keep
`versionCode` `1`. Debug builds always use the debug key, never the release key.

**Tag-derived versionCode.** When `PROTOVIEWER_RELEASE_VERSION` is supplied, the convention uses
`major * 1_000_000 + minor * 1_000 + patch`
(`ProtoViewerVersioning`). It is strictly monotonic in version order, bounded under Play's
2,100,000,000 cap (major <= 2099, minor and patch <= 999), and `0.0.89` gives `89`. The release
`versionName` is the same plain version.
The APK build receives the release version's MAJOR.MINOR.PATCH core, so prerelease and build-metadata
suffixes do not reach the convention and share the core's `versionCode`.

**AAB, R8 and mapping.** `:protoviewer:bundleRelease` writes
`build/outputs/bundle/release/protoviewer-release.aab`. Its finalizer is
`verifyProtoViewerReleaseAab` (required entries, jar signature present and not the Android debug
certificate when signing is required, R8 mapping present). When R8 is on, it is also finalized by
`archiveProtoViewerReleaseMapping` (`build/outputs/release-archive/mapping-<versionCode>.txt`, to
be kept as a release asset for as long as that version is supported). R8 is on for release (disable
locally with `-Pautomobile.protoviewer.minifyRelease=false`); `verifyReleaseR8KeptClasses` asserts
the manifest components, the saved-prototype `@Serializable` contract and the reflectively resolved
icon set survive. Unused `:protocol` wire models are shrunk away.

`build-protoviewer-apk.yml` builds the AAB with `build-aab: true` and uploads it with its mapping
archive. Only the Play pipeline (section 8.3) sets that input. Not yet wired: `lintRelease` in CI
and the `bundletool build-apks` install smoke test on a device.

## 8.3 Google Play publishing (#14147)

**Uploader: fastlane `supply`**
([decision](../devlog/2026-11-03-fastlane-supply-play-publishing.md)), reading the fastlane-layout
metadata in `fastlane/metadata/android`. `fastlane/Gemfile.lock` pins every gem with a checksum. The `setup-fastlane` action installs it frozen, with no gem cache.
`scripts/release/protoviewer-play.sh` builds every `supply` call.

**Flow** (`publish-protoviewer-play.yml`, started by pushing a `protoviewer/MAJOR.MINOR.PATCH` tag;
release.yml's `*` tag filter does not match a `/`):

1. `resolve` derives the versionCode (same formula as section 8.2). It fails when any locale lacks
   `fastlane/metadata/android/<locale>/changelogs/<versionCode>.txt`. `default.txt` does not count,
   because each release must have its own "What's new" text. Fast Validation checks the 500-character
   limit.
2. `build` is the only build. It calls `build-protoviewer-apk.yml` with `build-aab: true`.
3. `upload-internal` (environment `google-play-internal`) checks the AAB against the build job's
   SHA-256 and uploads it to the **internal** track with its release notes. It runs with no approval.
4. `promote-closed` and `promote-production` (environment `google-play-release`, with required
   reviewers) each wait for an approval. They move the same versionCode internal → closed track
   (`PLAY_CLOSED_TRACK`, default `alpha`) → production. They pass `--skip_upload_aab`, so nothing
   is rebuilt or uploaded again. Production starts as a staged rollout at
   `PLAY_INITIAL_PRODUCTION_ROLLOUT` (`0.1`).

**Secrets.** The service-account JSON is the environment secret `PLAY_SERVICE_ACCOUNT_JSON`,
defined in both Play environments and never as a repository secret. A step reads it only through
`SUPPLY_JSON_KEY_DATA`, so it is never written to disk. `test/bats/protoviewer-play-publish.bats`
pins this scoping and the single build. Give the service account release permissions for this app
only.

**Repository setup** (settings, not YAML):

- `google-play-internal`: deployment refs limited to `protoviewer/*` tags.
- `google-play-release`: required reviewers, prevent self-review, deployment refs limited to
  `protoviewer/*` tags and `main` (for dispatches).
- The Play API cannot create an app. Create the app and its first release in the Play Console.
  While the app has never been published, Play accepts only `draft` releases. Set the repository
  variable `PROTOVIEWER_PLAY_INTERNAL_STATUS=draft` until then, and roll the draft out in the
  console.

**Manual operations.** Run the workflow by dispatch with `version` and one `operation`:

- `promote-closed` or `promote-production`: re-run a promotion, for example after a pending
  approval expired (GitHub keeps one for 30 days).
- `rollout` with a `fraction`: widen the staged rollout. `1` completes it.
- `halt` with the current `fraction`: stop the staged rollout. Users who already updated keep the
  build.

Every dispatch needs a `google-play-release` approval. Runs are serialized per version only, so a halt never queues behind another version's pending approvals. A job waiting on an environment approval would hold an app-wide group. Play allows one open edit per user, so two versions' operations can still overlap and invalidate each other's edit. Because `supply` commits last, the script retries a failed call after 30 s and again after 90 s. **Resume** a halted rollout in the Play
Console (Production → Releases → Resume rollout): `supply` only updates in-progress or draft
releases. To roll back, ship a fix under a higher version. Play has no rollback to a lower
versionCode.

**Closed-test requirement.** The Play account is a personal enrollment (#14144). A personal account created
after 2023-11-13 gets production access only after a closed test with at least 12 testers opted in
for 14 continuous days. The testers are a Google Group or email list on the closed track in the
Play Console. It is kept there and not in this repository, because it is personal data. Until Play
grants production access, `promote-production` fails at Play, and the release stays on the closed
track.

## 8.4 Staged-rollout release gates (#16516)

There is no crash SDK, so store vitals and Copy diagnostics are the quality signals. A version's rollout
stops widening when its rate crosses a gate:

| Platform | Signal (for the new version only)      | Gate    | Action                                  |
| -------- | -------------------------------------- | ------- | --------------------------------------- |
| Android  | Play Console user-perceived crash rate | > 1.09% | `halt` the staged rollout (section 8.3) |
| Android  | Play Console user-perceived ANR rate   | > 0.47% | `halt` the staged rollout (section 8.3) |
| iOS      | Xcode Organizer crash rate             | > 1.09% | Pause the phased release                |

The Android gates are Play's bad-behavior thresholds; crossing them also lowers store ranking. iOS
uses the same fixed crash-rate threshold. The iOS gate applies once phased App
Store releases exist (#14150).

**Release checklist: check vitals before widening rollout.** The `google-play-release` approver checks the gates, using the new version's vitals,
before approving every step that widens exposure:

1. Before approving `promote-production`: the closed-track version is under every gate.
2. Before every `rollout` dispatch: the production version is under every gate at its current
   fraction.
3. If a gate is crossed at any point: dispatch `halt` (iOS: pause the phased release) and ship the fix
   under a higher version.
