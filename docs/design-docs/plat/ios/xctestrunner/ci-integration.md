# CI Integration

This page covers running AutoMobile XCTestRunner tests in GitHub Actions using a macOS runner with
a built-in iOS Simulator. The `automobile-tests` job shown here is the reference workflow used in
the `ios-build` repository.

## Overview

AutoMobile tests need a pre-built `.xctestrun` containing the `YourAppAutoMobileTests` bundle, a
booted iOS Simulator, a running AutoMobile daemon reachable over the Unix socket, and the CtrlProxy
iOS app installed in the simulator.

> [!NOTE]
> **No cloud device service required.** Unlike Android — which uses
> [emulator.wtf](https://emulator.wtf) to provision managed cloud emulators — iOS
> AutoMobile tests run on the macOS runner's built-in iOS Simulator. No external
> device service or additional secrets are needed.

## Job structure

The reference workflow splits testing into two independent jobs that share the same build artifact:

```text
build-for-testing ──┬──► simulator-tests      (unit tests, skips AutoMobile bundle)
                    └──► automobile-tests      (AutoMobile tests only)
```

Both jobs download the same `.xctestrun` artifact from `build-for-testing` and run
`xcodebuild test-without-building` with different filtering flags, so there is no duplicate
compilation.

## Full workflow job

```yaml
automobile-tests:
  name: "AutoMobile XCTestRunner Tests"
  runs-on: macos-26
  needs: [build-for-testing]
  timeout-minutes: 30
  env:
    # Match the AutoMobile version pinned by the XCTestRunner package resolution.
    AUTOMOBILE_VERSION: "<runner-version>"
  steps:
    - uses: actions/checkout@v6

    - name: Select Xcode 26.2
      uses: maxim-lobanov/setup-xcode@v1
      with:
        xcode-version: "26.2"

    - name: Setup Bun
      uses: oven-sh/setup-bun@v2

    - name: Install auto-mobile CLI
      run: bun install -g "@kaeawc/auto-mobile@${AUTOMOBILE_VERSION}"

    - name: Ensure iOS Simulator runtime
      uses: ./.github/actions/ensure-ios-simulator-runtime

    - name: Download build products
      uses: actions/download-artifact@v7
      with:
        name: build-for-testing-macos-26
        path: build/DerivedData/Build/Products/

    - name: Boot iOS Simulator
      run: |
        ios_version="$(xcrun --sdk iphonesimulator --show-sdk-version)"
        auto-mobile --boot-device --platform ios --create-if-missing --timeout-ms 600000 \
          --min-os-version "${ios_version}" --max-os-version "${ios_version}"

    - name: Start simulator log stream
      run: |
        mkdir -p build
        xcrun simctl spawn booted log stream \
          --level debug --style compact --color none \
          --predicate 'subsystem BEGINSWITH "com.example.ios"' \
          > build/automobile-simulator.log 2>&1 &
        echo "LOG_STREAM_PID=$!" >> "$GITHUB_ENV"

    - name: Start AutoMobile daemon
      run: auto-mobile --daemon start

    - name: Wait for daemon and register simulator
      run: auto-mobile --cli observe --platform ios

    - name: Run AutoMobile tests
      run: xcodebuild test-without-building -xctestrun "$xctestrun_file" -destination "platform=iOS Simulator,id=$booted_udid" -only-testing:YourAppAutoMobileTests -enableCodeCoverage NO -skipMacroValidation

    - name: Stop AutoMobile daemon
      if: always()
      run: auto-mobile --daemon stop || true

    - name: Stop simulator log stream
      if: always()
      run: kill "$LOG_STREAM_PID" 2>/dev/null || true

    - name: Upload test results
      uses: actions/upload-artifact@v6
      if: always()
      with:
        name: automobile-test-results
        path: build/automobile-tests.xcresult
        retention-days: 7

    - name: Upload simulator logs on failure
      uses: actions/upload-artifact@v6
      if: failure()
      with:
        name: automobile-simulator-logs
        path: build/automobile-simulator.log
        retention-days: 7
```

## Step notes

- **Bun and auto-mobile**: the daemon is a Node/Bun application, so `setup-bun` must precede
  `auto-mobile --daemon start`. Pin the CLI to the version the XCTestRunner package resolution uses.
- **Build products artifact**: the `build-for-testing` artifact holds both test bundles
  (`YourAppTests.xctest`, `YourAppAutoMobileTests.xctest`) and the `.xctestrun` referencing them,
  so the test runner never recompiles.
- **Boot**: `auto-mobile --boot-device` finds the simulator matching the current Xcode SDK,
  creating and booting it if missing. `xcrun simctl boot "iPhone 16"` also works.
- **Daemon**: `auto-mobile --daemon start` launches the managed daemon, waits for readiness and
  exits. Its launcher PID is not the daemon PID, so do not save it for cleanup.
- **CtrlProxy pre-install**: `auto-mobile --cli observe --platform ios` blocks until the daemon
  socket is up and installs CtrlProxy into the booted simulator if absent, so the first `observe`
  in a test plan does not pay the install cost.
- **Run**: set `xctestrun_file` and `booted_udid` in the same shell step (or export via
  `GITHUB_ENV`). These are application-specific; the repository ships no test-without-building
  wrapper (`scripts/ios/xcode-test.sh` builds and tests repository Xcode projects instead).
  `-only-testing:YourAppAutoMobileTests` limits execution to the AutoMobile bundle.
- **Cleanup**: `if: always()` guards stop the daemon (it resolves the detached process from its PID
  file) and the log stream. The simulator stays booted; macOS runners are ephemeral.

| Artifact                    | When uploaded | Contents                                                           |
| --------------------------- | ------------- | ------------------------------------------------------------------ |
| `automobile-test-results`   | Always        | `build/automobile-tests.xcresult` (pass/fail, timing, screenshots) |
| `automobile-simulator-logs` | On failure    | `build/automobile-simulator.log` filtered to your app's subsystem  |

## Keeping unit tests and AutoMobile tests separate

The `simulator-tests` job runs the complement of `automobile-tests` with
`-skip-testing:YourAppAutoMobileTests` (plus `-parallel-testing-enabled YES`), mirroring Android's
`testDebugUnitTest -PexcludeAutoMobileTests` versus `--tests '*.automobiletest.*'`.

## Caching strategy

The `ios-xctest-runner-simulator-tests` job (`.github/workflows/xctestrunner-simulator-tests.yml`,
run on PRs labelled `run-ios-sim`; its nightly run is the CircleCI `xctestrunner-simulator-tests`
job in `.circleci/continue_config.yml`, #11010) restores two cache layers before its
`build-for-testing` invocation. It resolves the CtrlProxy package after restore, so a manifest
change still fetches any newly introduced dependency before the cached DerivedData is reused:

| Cache                     | Key                                                              | What it stores                                                                                                                                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SPM packages              | `macOS-spm-xctestrunner-26.5-<hash(Package.swift files)>`        | `~/Library/Caches/org.swift.swiftpm` and `~/.swiftpm/cache` (SwiftPM's global package/artifact cache); `~/.swiftpm` itself, including machine-specific `configuration/` and `security/` state, is deliberately excluded so a self-hosted runner's SwiftPM tree can never leak onto a hosted-runner fallback |
| DerivedData intermediates | `macOS-derived-xctestrunner-26.5-<hash(CtrlProxy build inputs)>` | `/tmp/automobile-ctrl-proxy/Build` and `/tmp/automobile-ctrl-proxy/ModuleCache.noindex` build products/module cache; not `SourcePackages`                                                                                                                                                                   |

The restore-key prefixes retain the `26.5` toolchain segment, so a different Xcode version never
restores compiled artifacts from this lane. Source changes fall back to the prior matching-toolchain
entry for incremental compilation.

Because [`actions/cache` never updates an existing key](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#cache-key-matching),
every DerivedData `hashFiles(...)` call — here and in the analogous Xcode-build and Playground
jobs — must cover every compiled, configuration, and resource input for the
scoped project directory, not just `*.swift` sources and the project descriptor. Restricting the
hash to Swift files means an Objective-C shim, an `.xcconfig`, `Info.plist`, an asset catalog, a
font, or a storyboard/xib can change while the key still hits exactly, so the freshly rebuilt
DerivedData for that changed input is never saved — every later run keeps restoring the stale
build. Each key therefore hashes, scoped to that job's project directory (and any local Swift
package directories it depends on): `*.swift`, `*.m`, `*.mm`, `*.h`, `*.c`, `*.cpp`, `*.xcconfig`,
`*.plist`, `*.entitlements`, `*.storyboard`, `*.xib`, `*.xcassets/**`, `*.strings`, `*.ttf`,
`*.otf`, `*.xcprivacy`, `*.pbxproj`, `*.xcscheme`, `project.yml`, `Package.swift`, and `Package.resolved` —
excluding `.build/`, `DerivedData/`, and `SourcePackages/` (already excluded by scoping to source
directories, matching the SPM cache-path exclusions above).

## Required secrets

No additional secrets are required for a basic AutoMobile test run. The macOS runner has Xcode
and iOS Simulator built in, and the daemon communicates entirely over a local Unix socket.

If you add features that require external services (e.g., a staging backend with an API key), pass
them as environment variables through the test scheme:

```yaml
- name: Run AutoMobile tests
  env:
    AUTOMOBILE_TEST_API_KEY: ${{ secrets.TEST_API_KEY }}
  run: xcodebuild test-without-building -xctestrun "$xctestrun_file" -destination "platform=iOS Simulator,id=$booted_udid" -only-testing:YourAppAutoMobileTests -enableCodeCoverage NO -skipMacroValidation
```

Resolve them from the environment in the test target before executing the plan.

## Reading results from CI

Download the `automobile-test-results` artifact and inspect with xcresulttool:

```bash
xcrun xcresulttool get test-results summary \
  --path automobile-tests.xcresult

xcrun xcresulttool get test-results tests \
  --path automobile-tests.xcresult --format json \
  | jq '[.. | objects | select(.testStatus? == "Failure") | .nodeIdentifier]'
```

## See also

- [UI tests](../../../../using/ui-tests.md) — dependency setup, YAML plans, and
  `AutoMobileTestCase` usage
