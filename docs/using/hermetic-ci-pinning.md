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

- Unset (or `latest`, case-insensitive) resolves to the newest entry in the daemon's
  baked release registry — a **concrete** version, never the floating `@latest` tag.
- A version **in** the daemon's baked registry is downloaded and its SHA-256 is verified.
- A version **not** in the registry (a typo, or a real release newer than the daemon's
  baked registry) has no checksum to verify against, so the download **fails closed** —
  the daemon refuses to install an unverifiable asset. To use a not-yet-baked release,
  either upgrade the daemon to one whose registry includes it, or take the explicit
  escape hatch: `AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM=1` (Android) / vendor a trusted
  bundle via `AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH` (iOS).
- The Android Kotlin runner reads `AUTOMOBILE_VERSION` as a fallback for the daemon
  package version, so a daemon **this runner spawns** lines up. A **pre-existing** shared
  daemon does not re-read it — see [Shared daemon caveat](#shared-daemon-caveat).

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

For any version in the daemon's baked registry, the downloaded asset's SHA-256 is
verified against that registry, so a mirror **cannot** serve a tampered asset for a
registry-known version. For a version **not** in the registry there is nothing to verify
against, so the download fails closed (see the `AUTOMOBILE_VERSION` notes above) — a
mirror can only serve unverified assets if you deliberately opt out of verification.

`AUTOMOBILE_ASSET_BASE_URL` (and the iOS-only `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_URL`
bundle override) **must use `https://`** (issue [#4761](https://github.com/kaeawc/auto-mobile/issues/4761)).
A plaintext `http://` base is rejected because asset fetches over cleartext are a
confidentiality/downgrade risk even though the pinned checksum still blocks
substitution. For a trusted loopback/dev mirror (e.g. `http://127.0.0.1:8080`),
set `AUTOMOBILE_ALLOW_INSECURE_ASSET_URL=1` to opt back into `http://`.

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
   export AUTOMOBILE_REPO_ROOT="$GITHUB_WORKSPACE" # checkout with dist/src/index.js
   ```
   Pin the XCTestRunner SPM dependency to the matching git tag. When
   `AUTOMOBILE_REPO_ROOT` (or the runner's source checkout) contains
   `dist/src/index.js`, XCTestRunner starts or restarts that exact checkout's daemon and
   rejects a same-release daemon from a different checkout. Set the variable explicitly
   for an embedding project or CI layout where the runner source cannot identify the
   checkout. For a package consumer without a built checkout, XCTestRunner falls back to
   the PATH `auto-mobile` CLI; pin the exact `@kaeawc/auto-mobile@0.0.40` there or start
   the daemon yourself before the test job. (Embedding a package-version pin in the Swift
   runner remains tracked by [#2746](https://github.com/kaeawc/auto-mobile/issues/2746).)
2. **Vendor the IPA** so nothing is fetched or compiled at test time:
   ```bash
   export AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH=/opt/automobile/control-proxy.ipa
   ```
   The daemon copies (and extracts) this local bundle directly — no network fetch, no
   Xcode build. **Do not also set `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=1`**: that flag
   short-circuits `needsRebuild()` and returns *before* the vendored IPA is consumed, so
   on a fresh host CtrlProxy would never be installed. Use `AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=1`
   only when the extracted xctestrun artifacts are *already* present on the host.
   Alternatively, set `AUTOMOBILE_ASSET_BASE_URL` to your mirror for a checksummed
   download of a registry-known version (leave the IPA path unset).
3. **Gate the job** on doctor:
   ```bash
   bunx @kaeawc/auto-mobile@0.0.40 --cli doctor --ios
   ```

## Shared daemon caveat

The pin is a property of **the daemon's launch environment**, resolved where the download
happens. AutoMobile runs **one daemon per UID**, shared across worktrees via a single
socket + PID file.

The checkout-aware iOS XCTestRunner path above is an exception: when it has a built
`AUTOMOBILE_REPO_ROOT` (or can identify its source checkout), it reconciles a running daemon
whose release or checkout build identity differs by restarting it from that checkout. A
pin-only asset mismatch fails closed with a diagnostic instead of silently reusing the daemon;
restart the daemon from the runner's environment to reconcile that case.

Other runners reuse an already-running daemon rather than restart it. If a daemon is already
up with a different `AUTOMOBILE_VERSION` (or none), a second job that exports a new pin will
silently be served by the **existing** daemon — the pin is ignored until the daemon is restarted.

For hermetic CI runners that do not use the checkout-aware XCTestRunner path, force a clean
daemon so the pin actually takes effect:

- **Android:** `-Dautomobile.daemon.force.restart=true` (already in the recipe above).
- **Other unreconciled runners:** `bunx @kaeawc/auto-mobile@<version> --daemon restart` before
  the job, then confirm via `ide/status` (below) that `releaseVersion` matches your pin.

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
hermetic — either `AUTOMOBILE_VERSION` was not exported into the daemon's process, or a
pre-existing daemon with a different pin is still serving (see
[Shared daemon caveat](#shared-daemon-caveat)). Restart the daemon and re-check.
