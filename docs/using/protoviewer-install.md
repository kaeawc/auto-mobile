# Installing ProtoViewer on Android

ProtoViewer is the standalone app for opening, switching between and sharing saved prototypes.
See the [design doc](../how-it-works/protoviewer.md). `prototype save` on Android routes to it when
it is installed, so install it once per device or emulator you use.

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

`adb install -r` replaces an installed ProtoViewer in place and keeps its saved prototypes. The new
APK must be signed with the same key and have an equal or higher `versionCode`.

When a spec needs something the installed ProtoViewer cannot show, `prototype save` refuses it
before copying anything to the device. The result has `errorCode: "unsupported_capability"` and an
`update` object with `missingCapabilities`, `installedVersion` and a `url` for a newer build.
Update ProtoViewer as above and save again. AutoMobile supports the three most recent ProtoViewer
releases.

## iOS

The iOS simulator template viewer (`AutoMobilePrototypeViewer.zip`) is a separate artifact and is
downloaded automatically. A ProtoViewer build for physical iPhones is not part of the release yet.
