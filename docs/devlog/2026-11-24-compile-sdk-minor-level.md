# compileSdk carries a minor API level

- Kind: decision
- Date: 2026-11-24
- Source: #19140 (supersedes #19082)
- Shaped: [Android 17 behaviour changes for targetSdk 37 (CtrlProxy audit)](../how-it-works/plat/android/android-17-target-sdk-audit.md)

## Context

Compose BOM 2026.11.01 (Compose 1.13.0, Material 3 1.5.0) has AAR metadata that requires
compileSdk 37.1. The convention plugins read `build-android-compileSdk` as an Int, so every
Android module failed `checkAarMetadata`.

## Options

Not recorded beyond the two forms checked in the PR: a separate catalog key for the minor level,
or one `<major>.<minor>` value.

## Decision

`build-android-compileSdk` holds `<major>` or `<major>.<minor>`, now `"37.1"`. The convention
plugins parse it and use AGP's `compileSdk { version = release(major) { minorApiLevel = minor } }`.
install.sh uses the value as the `platforms/android-<value>` directory. video-server looks for
`platforms/android-<value>` first. Without it, video-server falls back to the major platform's
`android.jar`, so it does not need `android-37.1`.

## Consequences

The SDK platform required is `platforms;android-37.1`. Apps that consume the published SDK or the
prototype renderer AAR must also compile against 37.1. targetSdk stays an Int (37).
