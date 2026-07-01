# Hermetic CI Pinning

AutoMobile is made of several components that must agree on one version:

| Component | What it is |
|-----------|------------|
| **Daemon** | The `@kaeawc/auto-mobile` npm package (stdio/MCP + Unix-socket server) |
| **Android CtrlProxy APK** | On-device accessibility service, downloaded by the daemon |
| **iOS CtrlProxy IPA** | On-device XCUITest runner bundle, downloaded by the daemon |
| **Android junit-runner** | Kotlin runner that spawns the daemon during tests |
| **iOS XCTestRunner** | Swift runner that autostarts the daemon during tests |

The repo's own CI is hermetic *by construction* — every component comes from a single
checkout — so a version knob is not needed there. **External CI consumers** don't have
that luxury: their inputs are independent, and without pinning they can silently drift
(a `@latest` daemon pulling one APK while a runner expects another). This page documents
how to pin everything to **one coherent version** and, optionally, mirror the release
assets for offline builds.

## The knobs

### `AUTOMOBILE_VERSION` — the single-version knob

Set `AUTOMOBILE_VERSION` to a released version (e.g. `0.0.40`) to pin the daemon package,
the Android APK, the iOS IPA, and their expected SHA-256 checksums together. The daemon
resolves all four from one value, so there is no way for them to disagree.

```bash
export AUTOMOBILE_VERSION=0.0.40
```

- Unset (or `latest`) resolves to the newest entry in the daemon's baked release registry
  — a **concrete** version, never the floating `@latest` tag.
- An unknown version resolves to an empty checksum (download proceeds unverified only if
  you have also opted into a checksum-skip override — see below).
- The Android Kotlin runner already reads `AUTOMOBILE_VERSION` as a fallback for the
  daemon package version, so the same env var lines up the runner-spawned daemon too.

### `AUTOMOBILE_ASSET_BASE_URL` — the mirror knob

By default the daemon downloads the APK/IPA from GitHub Releases. For hermetic,
offline-capable CI, mirror the assets and point the daemon at your mirror:

```bash
export AUTOMOBILE_ASSET_BASE_URL=https://artifacts.internal/automobile
```

The daemon fetches `${AUTOMOBILE_ASSET_BASE_URL}/${version}/control-proxy-debug.apk`
(and `.../control-proxy.ipa`). Lay your mirror out with a directory per version:

```
https://artifacts.internal/automobile/
  0.0.40/
    control-proxy-debug.apk
    control-proxy.ipa
```

Checksums are still verified against the daemon's baked registry, so a mirror cannot
serve a tampered asset for a pinned version.

## Android hermetic recipe

1. **Pin the runner + daemon:**
   ```bash
   export AUTOMOBILE_VERSION=0.0.40
   ```
   In Gradle, pin the Maven coordinate of `junit-runner` to the matching release and set
   `-Dautomobile.daemon.package.version=0.0.40` (or rely on `AUTOMOBILE_VERSION`).
2. **Provision the APK out-of-band** so no network fetch happens at test time:
   ```bash
   export AUTOMOBILE_CTRL_PROXY_APK_PATH=/opt/automobile/control-proxy-debug.apk
   ```
   (or set `AUTOMOBILE_ASSET_BASE_URL` to your mirror for a checksummed download).
3. **Force a clean daemon** so a stale reused daemon can't serve a different build:
   ```bash
   export AUTOMOBILE_DAEMON_PACKAGE_VERSION=0.0.40   # explicit runner-side pin
   # -Dautomobile.daemon.force.restart=true
   ```
4. **Gate the job** on doctor so drift is a hard failure:
   ```bash
   bunx @kaeawc/auto-mobile@0.0.40 --cli doctor
   ```

## iOS hermetic recipe

1. **Pin the runner + daemon:**
   ```bash
   export AUTOMOBILE_VERSION=0.0.40
   ```
   Pin the XCTestRunner SPM dependency to the matching git tag.
2. **Vendor the IPA and skip the build** so nothing is fetched or compiled at test time:
   ```bash
   export AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH=/opt/automobile/control-proxy.ipa
   export AUTOMOBILE_SKIP_CTRL_PROXY_IOS_BUILD=1
   ```
   (or set `AUTOMOBILE_ASSET_BASE_URL` to your mirror for a checksummed download).
3. **Gate the job** on doctor:
   ```bash
   bunx @kaeawc/auto-mobile@0.0.40 --cli doctor --ios
   ```

## Verifying the pin

Ask the running daemon what it will actually fetch — the `ide/status` handler reports the
**concrete** resolved version plus the exact (mirror-aware) URLs and checksums:

```jsonc
{
  "releaseVersion": "0.0.40",
  "android": {
    "ctrlProxy": {
      "url": "https://artifacts.internal/automobile/0.0.40/control-proxy-debug.apk",
      "expectedSha256": "…"
    }
  },
  "ios": {
    "xcTestService": {
      "url": "https://artifacts.internal/automobile/0.0.40/control-proxy.ipa",
      "expectedSha256": "…"
    }
  }
}
```

If `releaseVersion` is anything other than the version you pinned, the environment is not
hermetic — check that `AUTOMOBILE_VERSION` is exported into the daemon's process.
