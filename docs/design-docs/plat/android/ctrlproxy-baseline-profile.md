# CtrlProxy baseline profile

The release CtrlProxy APK ships an ART baseline profile, `assets/dexopt/baseline.prof` with its
`baseline.profm` metadata, so ART compiles the service's hot paths ahead of time instead of
interpreting them after each install.

## Sources

AGP merges two rule sources for the release variant:

- `android/control-proxy/src/main/baseline-prof.txt`: hand-authored rules for the manifest
  components and the hot paths (accessibility event handling and hierarchy extraction, the Ktor CIO
  WebSocket server, the IME, prototype rendering, and the serialized models). Its unit test keeps
  every rule well formed and every manifest component covered.
- `android/control-proxy/src/main/generated/baselineProfiles/`: rules recorded on a device by
  `:control-proxy-baselineprofile`. Absent until someone runs the generator.

R8 expands wildcard rules and rewrites them to the obfuscated names before AGP compiles the binary
profile, so the packaged profile matches the minified dex.

## Regenerating on a device

`:control-proxy-baselineprofile` is a Macrobenchmark `com.android.test` module (convention
`automobile.android-baseline-profile-generator`). With one emulator or device connected, API 33+ or
rooted API 28+:

```bash
./gradlew -p android :control-proxy:generateBaselineProfile
```

It launches `MainActivity`, enables the CtrlProxy accessibility service through `settings`, then
sends `request_hierarchy`, `request_tap_coordinates` and `request_swipe` over
`ws://127.0.0.1:8765/ws`, the requests the daemon sends through its forwarded port. The plugin
writes the recorded rules into the generated directory above; commit them with the change that
regenerated them. The convention plugin sets `automaticGenerationDuringBuild = false`, so no
release build needs a device. CI never runs the generator.

## Applying the profile on sideloaded installs

The daemon installs CtrlProxy with `adb install`, which skips the Play Store's profile
installation. `androidx.profileinstaller` (declared directly) writes the packaged profile for ART
when the app process first starts, and ART compiles it during the next background dexopt.

## Release guard

`:control-proxy:verifyReleaseBaselineProfile` runs before `assembleRelease` completes. It decodes
the packaged binary profile, resolves its class entries through each `classesN.dex` type table, and
fails unless both `assets/dexopt` entries exist and the profile lists every CtrlProxy manifest
component. A size check would not do: the libraries' own profiles still compile to a non-empty
file when CtrlProxy's rules stop matching.
