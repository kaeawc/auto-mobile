# Installing ProtoViewer on Android

ProtoViewer is the standalone app for opening, switching between and sharing saved prototypes (see
the [design doc](../design-docs/protoviewer.md)). `prototype save` on Android routes to it when it is
installed, so install it once per device or emulator you use.

Every GitHub release carries two ProtoViewer assets next to the CtrlProxy APK:

- `automobile-protoviewer-<version>.apk`
- `automobile-protoviewer-<version>.apk.sha256`

The APK is built by Prepare Release from the release commit, signed with the release key, and its
SHA-256 is pinned in `src/constants/release.ts` as `protoViewerApkSha256`. Release refuses to publish
if the APK is missing, differs from that pinned value, or is signed with the Android debug key.

## Install

```bash
VERSION=0.0.89   # the release you want
BASE="https://github.com/kaeawc/auto-mobile/releases/download/${VERSION}"
curl -fsSLO "${BASE}/automobile-protoviewer-${VERSION}.apk"
curl -fsSLO "${BASE}/automobile-protoviewer-${VERSION}.apk.sha256"

# Verify the checksum (macOS: shasum -a 256 -c ...)
sha256sum -c "automobile-protoviewer-${VERSION}.apk.sha256"

adb install -r "automobile-protoviewer-${VERSION}.apk"
```

The release notes repeat the SHA-256, and it must also equal the `protoViewerApkSha256` of that
version's entry in `RELEASE_CHECKSUM_REGISTRY`.

To check which key signed the APK (it must not be the debug certificate):

```bash
apksigner verify --print-certs "automobile-protoviewer-${VERSION}.apk"
```

## Updating

`adb install -r` replaces an installed ProtoViewer in place and keeps its saved prototypes, as long
as the new APK is signed with the same key and has an equal or higher `versionCode`.

## Signing key and version code

- **Key:** ProtoViewer is signed with the same release keystore as CtrlProxy (the `RELEASE_KEYSTORE_*`
  secrets), because no separate key exists yet. The key is permanent for the package's update path.
  Moving to its own key, or to a Play upload key (#14146), is a later decision that would require
  uninstalling the old app first.
- **versionCode:** currently fixed at `1`, which `adb install -r` accepts when equal. Adopt a
  tag-derived scheme (#14146) before any flow that needs strictly increasing codes.
- **Fail closed:** the release workflow sets `PROTOVIEWER_REQUIRE_RELEASE_SIGNING=true`, so a
  `:protoviewer:assembleRelease` without complete signing inputs fails instead of falling back to the
  debug key. Local and pull-request builds are unaffected and stay debug-signed.

## iOS

The iOS simulator template viewer (`AutoMobilePrototypeViewer.zip`, `prototypeViewerSha256`) is a
separate artifact and is downloaded automatically. A dev-signed ProtoViewer for physical iPhones is
not part of the release yet: it needs an Apple Developer signing certificate and provisioning profile
as repository secrets, which are not configured (#13623).
