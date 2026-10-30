# Installing ProtoViewer on Android

ProtoViewer is the standalone app for opening, switching between and sharing saved prototypes (see
the [design doc](../design-docs/protoviewer.md)). `prototype save` on Android routes to it when it is
installed, so install it once per device or emulator you use.

Every GitHub release carries two ProtoViewer assets next to the CtrlProxy APK:

- `automobile-protoviewer-<version>.apk`
- `automobile-protoviewer-<version>.apk.sha256`

The APK is signed with the release key.

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

The checksum is also published with the release notes.

To check which key signed the APK (it must not be the debug certificate):

```bash
apksigner verify --print-certs "automobile-protoviewer-${VERSION}.apk"
```

## Updating

`adb install -r` replaces an installed ProtoViewer in place and keeps its saved prototypes, as long
as the new APK is signed with the same key and has an equal or higher `versionCode`.

## iOS

The iOS simulator template viewer (`AutoMobilePrototypeViewer.zip`) is a separate artifact and is
downloaded automatically. A ProtoViewer build for physical iPhones is not part of the release yet.
