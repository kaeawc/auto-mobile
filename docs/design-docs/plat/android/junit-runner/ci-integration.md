# CI Integration

This page describes how to run AutoMobile **JUnit runner** tests in CI using an
[emulator.wtf](https://emulator.wtf) ADB session (cloud emulator, `adb` on the runner talks to it).

**In MkDocs:** Android → JUnitRunner → **CI Integration**.

---

## This repository: emulator.wtf setup

Downstream forks and maintainers enable a **separate** job from the default GitHub-hosted emulator.

### How it works (high level)

1. **ew-cli** starts an emulator.wtf session with **`--adb`**, so the managed device appears on the runner’s ADB server (same idea as the generic flow below).
2. Composite action **`.github/actions/android-emulator-wtf`** installs the CLI, runs **`scripts/android/start-emulator-wtf-session.sh`**, then **`scripts/android/run-emulator-tests.sh`** (CtrlProxy APK install + env), then your Gradle command, then **`scripts/android/stop-emulator-wtf-session.sh`** on `always()`.
3. **`run-emulator-tests.sh`** sets `AUTOMOBILE_CTRL_PROXY_APK_PATH`, bumps **`AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS`** for slow cloud devices, and runs the test script with retries for transient ADB/network errors.
4. The JUnit runner test process starts (or connects to) the **AutoMobile daemon** and drives the device over ADB like local development.

### Default CI vs emulator.wtf

| Path                | Workflow                                                                      | When it runs                                                          |
| ------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **GitHub emulator** | `.github/actions/android-emulator` (`reactivecircus/android-emulator-runner`) | Android jobs on, no extra repo variable                               |
| **emulator.wtf**    | `.github/actions/android-emulator-wtf`                                        | Android jobs on **and** `EMULATOR_WTF_ENABLED` **and** API secret set |

The emulator.wtf job in **`.github/workflows/pull_request.yml`** is named **`junit-runner-emulator-wtf-tests`**. It depends on **`build-android-control-proxy`** for the CtrlProxy APK artifact.

### Enable emulator.wtf for this repo

1. **Repository variable** (Settings → Secrets and variables → Actions → **Variables**):  
   **`EMULATOR_WTF_ENABLED`** = `true`  
   The job is gated with:  
   `vars.EMULATOR_WTF_ENABLED == 'true'`.

2. **Repository secret**: **`EMULATOR_WTF_API_KEY`**  
   The workflow passes it into the composite action as **`EW_API_TOKEN`**, which **`ew-cli`** requires.

3. **emulator.wtf account**: `start-session --adb` may need to be enabled for your org. If the CLI errors, contact [support@emulator.wtf](mailto:support@emulator.wtf) (see emulator.wtf docs).

4. **Tune session length / device** in the workflow step that calls `android-emulator-wtf`:  
   `device` (e.g. `model=Pixel7,version=35,gpu=auto`) and `max-time-limit` (e.g. `2m`) are inputs on the composite action.

If the variable is on but the secret is missing, the job fails fast with an explicit error in the **Check API Key** step.

### Source files to read

| Piece                | Location                                                                        |
| -------------------- | ------------------------------------------------------------------------------- |
| Job definition       | `.github/workflows/pull_request.yml` → `junit-runner-emulator-wtf-tests`        |
| Composite action     | `.github/actions/android-emulator-wtf/action.yml`                               |
| Session lifecycle    | `scripts/android/start-emulator-wtf-session.sh`, `stop-emulator-wtf-session.sh` |
| CLI install          | `scripts/android/install-ew-cli.sh`                                             |
| APK + Gradle wrapper | `scripts/android/run-emulator-tests.sh`                                         |

---

## Adapting for a client (consuming) Android app

The flow above is wired to **this** repository (`:junit-runner:test`, `android/` layout, CtrlProxy built in-tree). To run **your** app’s AutoMobile JUnit tests on emulator.wtf, keep the same **ideas** (ADB session → install CtrlProxy → run JVM tests that talk to daemon + device) and replace the **inputs** below.

### 1. Reuse vs copy

| Approach                  | What to do                                                                                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Copy scripts + action** | Vendor `scripts/android/start-emulator-wtf-session.sh`, `stop-emulator-wtf-session.sh`, `install-ew-cli.sh`, and `run-emulator-tests.sh` from auto-mobile-mcp into your repo (preserve paths or update workflow references). Copy `.github/actions/android-emulator-wtf` and adjust only if script locations change. |
| **Minimal custom job**    | Implement the same steps inline (ew-cli `start-session --adb`, `adb wait-for-device`, boot wait, install CtrlProxy, Gradle, cleanup). The scripts mainly encode retries, env vars, and session PID handling—worth copying to avoid drift.                                                                            |

### 2. Workflow and job graph

| In auto-mobile-mcp                        | In your repo                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job `junit-runner-emulator-wtf-tests`     | Name it however you like; keep `needs:` pointing at whatever job **builds** artifacts you require.                                                                                                                                                                                             |
| `needs: […, build-android-control-proxy]` | `needs` must include a job that produces the **CtrlProxy** APK (or downloads a pinned release) **before** tests. If you also need your **app** APK for `launchApp` / plans, add a job (or step) that builds it and install it with `adb install` **before** or **as part of** the test script. |

### 3. Composite action inputs (`android-emulator-wtf`)

| Input                       | Replace with                                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `working-directory`         | Your Gradle project root if not `./android/` (e.g. monorepo `apps/myapp/`).                                                                                                                                                                                |
| `script`                    | The Gradle invocation that runs **your** JVM tests, e.g. `./gradlew :app:testDebugUnitTest --tests 'com.mycompany.automobile.*'` or `./gradlew :feature-ui-tests:test`. Use the same module and task you use locally.                                      |
| `accessibility-apk-path`    | Path to **CtrlProxy** debug (or compatible) APK **relative to `working-directory`**, or absolute from repo root if your wrapper script expects it. Must match what you document for `AUTOMOBILE_CTRL_PROXY_APK_PATH` in [Project Setup](project-setup.md). |
| `device` / `max-time-limit` | Adjust for API level, GPU, and how long cold boot + app install + tests take; under-provisioning causes flaky timeouts.                                                                                                                                    |

### 4. CtrlProxy APK source

Your client project does not ship `android/control-proxy` unless you vendor it. You still need a **binary** compatible with the junit-runner version you depend on. Typical options:

- Build CtrlProxy from a **git submodule** or fork of auto-mobile-mcp in CI, upload artifact, then pass that path into `run-emulator-tests.sh`.
- Build it in an earlier workflow job the same way this repo’s `build-android-control-proxy` job does, then `download-artifact` before the emulator.wtf step.

See [CtrlProxy](../control-proxy.md) for what the service does and version alignment expectations.

### 5. App under test (if your YAML plans need it)

`run-emulator-tests.sh` installs **CtrlProxy**, not necessarily **your product APK**. If plans call `launchApp` with your package id, CI must **install that APK** (or rely on a preloaded image—unusual). Add a step or extend your script:

- Build debug/release APK in CI, `adb install -r path/to/your-app.apk`, then run Gradle tests.

Without that, plans that expect your app may fail even when the runner and daemon are fine.

### 6. AutoMobile daemon and CLI on the runner

JUnit tests expect a **daemon** reachable via the usual socket (see [Project Setup → Running tests locally](project-setup.md)). In this repo, **`setup-auto-mobile-npm-package`** prepares the package; Gradle/test code starts or attaches to the daemon. For your app:

- Mirror that setup (Bun/Node, `auto-mobile` on `PATH`, or your internal equivalent).
- Keep **`AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS`** elevated for cloud emulators if you use the same script (already set inside `run-emulator-tests.sh`).

### 7. Secrets, variables, and naming

| Purpose            | auto-mobile-mcp                                              | Your repo (example)                                                                  |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| emulator.wtf token | Secret `EMULATOR_WTF_API_KEY` → `EW_API_TOKEN` in the action | Same pattern, or define `EW_API_TOKEN` secret directly if you do not use the rename. |
| Optional job gate  | Variable `EMULATOR_WTF_ENABLED`                              | Reuse the name or drop the `if:` once you always want cloud devices.                 |

### 8. Reports and artifacts

Update **artifact paths** and **JUnit report** `report_paths` to your module’s outputs (e.g. `**/build/test-results/**/*.xml` often still works). Heap dump upload paths should match where your tests write them, if any.

---

## Overview (any project)

AutoMobile JUnit tests need:

1. A **device or emulator** visible to `adb`
2. **CtrlProxy** installed on that device (this repo uses the debug APK from `control-proxy`)
3. A **running AutoMobile daemon** reachable over the Unix socket (started by the test stack / Gradle as in [Project Setup](project-setup.md))
4. A **Gradle test task** (e.g. `:junit-runner:test`) that talks to the daemon and ADB

The sections below walk through a **generic** GitHub Actions template you can adapt for other repositories. It uses secret name **`EW_API_TOKEN`** directly; **this repo** maps **`EMULATOR_WTF_API_KEY`** → **`EW_API_TOKEN`** in the workflow (see above).

## Reference workflow job (generic template)

```yaml
auto-mobile-tests:
  name: "AutoMobile JUnit Tests"
  runs-on: ubuntu-latest
  # Requires EW_API_TOKEN for the emulator.wtf ADB session.
  # Contact support@emulator.wtf to request access to start-session.
  if: github.secret_source == 'Actions'
  needs:
    - build-apk
  steps:
    - name: "Git Checkout"
      uses: actions/checkout@v4

    - name: "Setup Bun"
      uses: oven-sh/setup-bun@v2

    - name: "Install auto-mobile"
      shell: bash
      run: bun add -g @kaeawc/auto-mobile

    - name: "Download app APK"
      uses: actions/download-artifact@v4.1.8
      with:
        name: apk

    - name: "Install ew-cli"
      shell: bash
      run: |
        curl -fsSL \
          https://github.com/emulator-wtf/ew-cli/releases/latest/download/ew-cli-linux \
          -o /usr/local/bin/ew-cli
        chmod +x /usr/local/bin/ew-cli

    - name: "Start emulator.wtf ADB session"
      shell: bash
      env:
        EW_API_TOKEN: ${{ secrets.EW_API_TOKEN }}
      run: |
        ew-cli start-session \
          --device model=Pixel6,version=33,gpu=auto \
          --adb \
          --max-time-limit 20m &
        echo "EW_SESSION_PID=$!" >> "$GITHUB_ENV"
        adb wait-for-device
        adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done'

    - name: "Install app APK on emulator"
      shell: bash
      run: adb install app-debug.apk

    - name: "Start auto-mobile daemon"
      shell: bash
      run: |
        auto-mobile --daemon-mode &
        echo "AUTOMOBILE_DAEMON_PID=$!" >> "$GITHUB_ENV"
        until [ -S "/tmp/auto-mobile-daemon-$(id -u).sock" ]; do sleep 1; done

    - name: "Pre-install CtrlProxy via observe"
      shell: bash
      run: auto-mobile --cli observe --platform android

    - name: "Install JDK"
      uses: actions/setup-java@v5
      with:
        distribution: zulu
        java-version: "21"

    - name: "Setup Gradle"
      uses: gradle/actions/setup-gradle@v4
      with:
        cache-encryption-key: ${{ secrets.GRADLE_ENCRYPTION_KEY }}
        cache-cleanup: on-success
        validate-wrappers: true

    - name: "Restore Android SDK cache"
      id: cache-android-sdk
      uses: actions/cache/restore@v4
      with:
        path: |
          ~/.android
          ~/.config
        key: v1-${{ runner.os }}-android-sdk

    - name: "Setup Android SDK"
      if: steps.cache-android-sdk.outputs.cache-hit != 'true'
      uses: android-actions/setup-android@v3

    - name: "Save Android SDK cache"
      if: steps.cache-android-sdk.outputs.cache-hit != 'true'
      uses: actions/cache/save@v4
      with:
        path: |
          ~/.android
          ~/.config
        key: v1-${{ runner.os }}-android-sdk

    - name: "Run AutoMobile JUnit Tests"
      shell: bash
      run: >-
        ./gradlew :app:testDebugUnitTest
        --tests 'com.example.automobiletest.*'
        --continue
        --stacktrace

    - name: "Stop emulator.wtf session and daemon"
      if: always()
      shell: bash
      run: |
        kill "$AUTOMOBILE_DAEMON_PID" 2>/dev/null || true
        kill "$EW_SESSION_PID" 2>/dev/null || true

    - name: "Publish Test Report"
      uses: mikepenz/action-junit-report@v4
      if: always()
      with:
        check_name: "AutoMobile Test Report"
        report_paths: "app/build/test-results/**/*.xml"
```

## Step-by-step breakdown

### 1. Bun and auto-mobile

The daemon is a Node/Bun application. `setup-bun` ensures the Bun runtime is available on the
runner so that `auto-mobile --daemon-mode` works correctly.

```yaml
- uses: oven-sh/setup-bun@v2

- run: bun add -g @kaeawc/auto-mobile
```

Bun handles native dependencies automatically during installation.

### 2. emulator.wtf ADB session

The `start-session --adb` flag from [ew-cli](https://emulator.wtf/docs/ew-cli) provisions a
managed emulator and bridges its ADB connection to the runner's local ADB server, making the device
visible to all subsequent `adb` and `./gradlew` commands.

```bash
ew-cli start-session \
  --device model=Pixel6,version=33,gpu=auto \
  --adb \
  --max-time-limit 20m &
```

!!! note "Closed alpha feature"
`start-session --adb` is a closed alpha feature. Contact
[support@emulator.wtf](mailto:support@emulator.wtf) to request access.

After starting the session in the background, the step waits for the device to finish booting:

```bash
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done'
```

#### Device configuration options

| Flag               | Example values                         | Notes                                                                  |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------- |
| `model`            | `Pixel6`, `Pixel9Pro`, `GalaxyS22`     | Physical model to emulate                                              |
| `version`          | `30`–`35`                              | Android API level                                                      |
| `gpu`              | `auto`, `swiftshader_indirect`, `host` | GPU rendering mode; `auto` picks the best available                    |
| `--max-time-limit` | `10m`, `20m`, `30m`                    | Hard session time limit; the session ends and billing stops after this |

### 3. App APK installation

AutoMobile tests run against an already-installed app. The APK is downloaded from a prior
`build-apk` job artifact and installed onto the emulator:

```yaml
- name: "Download app APK"
  uses: actions/download-artifact@v4.1.8
  with:
    name: apk

- name: "Install app APK on emulator"
  run: adb install app-debug.apk
```

### 4. Daemon startup

Start the daemon in the background and capture its PID so it can be cleanly shut down at the end:

```bash
auto-mobile --daemon-mode &
echo "AUTOMOBILE_DAEMON_PID=$!" >> "$GITHUB_ENV"
until [ -S "/tmp/auto-mobile-daemon-$(id -u).sock" ]; do sleep 1; done
```

The `until` loop polls for the Unix socket file instead of using a fixed sleep, so it proceeds as
soon as the daemon is ready regardless of machine speed.

### 5. CtrlProxy pre-installation

The `--cli observe` command instructs the daemon to take a screenshot and capture the accessibility
hierarchy. As a side effect it installs the CtrlProxy accessibility service APK if it is not already
present:

```bash
auto-mobile --cli observe --platform android
```

Running this once before the test task ensures the CtrlProxy is ready before `observe` steps in
test plans execute, avoiding installation delays mid-test.

### 6. Gradle test task

The reference workflow above uses an internal composite action. If you are setting this up in your
own repository, expand it to these steps:

```yaml
- name: "Install JDK"
  uses: actions/setup-java@v5
  with:
    distribution: zulu
    java-version: "21"

- name: "Setup Gradle"
  uses: gradle/actions/setup-gradle@v4
  with:
    cache-encryption-key: ${{ secrets.GRADLE_ENCRYPTION_KEY }}
    cache-cleanup: on-success
    validate-wrappers: true

- name: "Restore Android SDK cache"
  id: cache-android-sdk
  uses: actions/cache/restore@v4
  with:
    path: |
      ~/.android
      ~/.config
    key: v1-${{ runner.os }}-android-sdk

- name: "Setup Android SDK"
  if: steps.cache-android-sdk.outputs.cache-hit != 'true'
  uses: android-actions/setup-android@v3

- name: "Save Android SDK cache"
  if: steps.cache-android-sdk.outputs.cache-hit != 'true'
  uses: actions/cache/save@v4
  with:
    path: |
      ~/.android
      ~/.config
    key: v1-${{ runner.os }}-android-sdk

- name: "Run AutoMobile JUnit Tests"
  shell: bash
  run: >-
    ./gradlew :app:testDebugUnitTest
    --tests 'com.example.automobiletest.*'
    --continue
    --stacktrace
```

`gradle/actions/setup-gradle` handles Gradle wrapper caching and the build cache automatically.
Environment variables like `AUTOMOBILE_CTRL_PROXY_APK_PATH` are safe with the configuration cache
as long as they are declared via `providers.environmentVariable()` in your Gradle build — which is
exactly what the [Project Setup](project-setup.md#gradle-test-task-configuration) example does.
Gradle tracks the provider as a configuration input and invalidates the cache entry automatically
when the value changes.

### 7. Cleanup

The `if: always()` ensures cleanup runs even when tests fail:

```bash
kill "$AUTOMOBILE_DAEMON_PID" 2>/dev/null || true
kill "$EW_SESSION_PID" 2>/dev/null || true
```

Killing the `ew-cli` background process ends the emulator.wtf session and stops billing.

### 8. Test report publishing

```yaml
- uses: mikepenz/action-junit-report@v4
  if: always()
  with:
    check_name: "AutoMobile Test Report"
    report_paths: "app/build/test-results/**/*.xml"
```

The JUnit XML reports written to `app/build/test-results/` are picked up and published as a GitHub
check, making failures visible in the PR Checks tab.

## Required secrets and variables

### This repository (`auto-mobile-mcp`)

| Name                    | Type     | Used by                                                         |
| ----------------------- | -------- | --------------------------------------------------------------- |
| `EMULATOR_WTF_API_KEY`  | Secret   | Passed as `EW_API_TOKEN` to `android-emulator-wtf` / `ew-cli`   |
| `EMULATOR_WTF_ENABLED`  | Variable | Must be `true` for job `junit-runner-emulator-wtf-tests` to run |
| `GRADLE_ENCRYPTION_KEY` | Secret   | Gradle configuration cache (shared with other Android CI jobs)  |

### Generic / fork template (YAML below)

| Secret                  | Used by                               | How to obtain                                                     |
| ----------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `EW_API_TOKEN`          | `ew-cli start-session`                | [emulator.wtf dashboard](https://emulator.wtf) → API tokens       |
| `GRADLE_ENCRYPTION_KEY` | Gradle configuration cache encryption | Generate a random 256-bit base64 key; store in repository secrets |

Configure these under **Settings → Secrets and variables → Actions** in your GitHub repository.

## Job dependencies

**This repository:** the emulator.wtf job uses `needs: [detect-changes, build-android-control-proxy]`
so the **CtrlProxy** APK artifact is available before tests run.

**Generic template:** if your workflow builds an app APK in an earlier job, depend on that job so the
test job can download the artifact:

```yaml
needs:
  - build-apk
```

## Conditional execution

The `if: github.secret_source == 'Actions'` guard prevents the job from running on forks or for
pull requests from contributors who do not have access to repository secrets. This avoids spurious
failures when `EW_API_TOKEN` is unavailable.

To also skip on draft pull requests:

```yaml
if: github.secret_source == 'Actions' && github.event.pull_request.draft != true
```

## Running without emulator.wtf

If you have a self-hosted runner with an emulator already running, omit the `ew-cli` steps and
replace the `adb wait-for-device` block with a step that starts your emulator. Everything else
(daemon startup, CtrlProxy pre-install, Gradle task) remains the same.

```yaml
- name: "Start AVD emulator"
  uses: reactivecircus/android-emulator-runner@v2
  with:
    api-level: 33
    target: google_apis
    arch: x86_64
    profile: pixel_6
    script: |
      adb wait-for-device
      adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done'
```

## Pre-release AutoMobile daemon (consumer app / GitLab CI)

Use this when you need a **fixed or unreleased** AutoMobile build (for example a daemon **loopback / `ConnectionRefused`** fix) **before** it appears on npm as `@kaeawc/auto-mobile`.

The JUnit runner can start the daemon from a **local checkout** instead of the package fallback when **`dist/src/index.js`** exists in that tree.

**Branch with the loopback fix (until merge + npm release):** clone **`https://github.com/kaeawc/auto-mobile.git`** at **`ryebread/connection_refused_in_ci_fix`**. After that lands on **`main`** and is published, switch the clone to **`--branch main`** (or drop this section and use npm only).

### 1. Add the AutoMobile repo to your pipeline

Pick one:

| Approach            | Outline                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Git submodule**   | Add the repo as a submodule pinned to the commit you need; clone recursively in CI.                                                                                   |
| **Clone step**      | `git clone --depth 1 --branch ryebread/connection_refused_in_ci_fix https://github.com/kaeawc/auto-mobile.git auto-mobile-mcp` (or another branch / SHA once merged). |
| **CI job artifact** | Another pipeline builds AutoMobile and passes `dist/` + `package.json` + lockfile as an artifact; extract beside your app.                                            |

The path you will pass to the runner must be the **repository root** (the directory that contains **`dist/src/index.js`** after build).

### 2. Build AutoMobile on the runner

The image must have **Bun** (or Node, if your runner resolves the daemon entrypoint to `node`; the JUnit runner prefers `bun` when present). From the AutoMobile root:

```bash
cd /path/to/auto-mobile-mcp
bun install
bun run build
```

Confirm **`dist/src/index.js`** exists.

### 3. Point Gradle / JVM tests at that tree

Set **one** of:

- **Environment:** `AUTOMOBILE_DAEMON_LOCAL_PROJECT_PATH=/absolute/path/to/auto-mobile-mcp`
- **Gradle (e.g. `build.gradle.kts` on the `test` task):** `systemProperty("automobile.daemon.local.project.path", "/absolute/path/to/auto-mobile-mcp")`

Optional for Android CI:

- **Soft keyboard:** JVM system property **`automobile.daemon.dismiss.keyboard.after.input=true`** so the runner appends **`--dismiss-keyboard-after-input`** on daemon **`start` / `restart`** (e.g. `-D…` on `./gradlew`, or `systemProperty` for unit test workers).
- **UI perf audit noise (`PerformanceAudit`, `J.create`, screenshot cancel):** **`AUTOMOBILE_DAEMON_NO_UI_PERF=true`** (or **`automobile.daemon.no.ui.perf.mode=true`**) so the runner appends **`--no-ui-perf-mode`** on **`start` / `restart`** (same as a manual pre-start).

See the JUnit runner README for details.

Use an **absolute** path in CI so Gradle workers do not depend on a fragile working directory.

**GitLab CI sketch:** clone or submodule AutoMobile into a known directory next to your app, build it, then export the variable for the Android test job:

```yaml
variables:
  AUTOMOBILE_DAEMON_LOCAL_PROJECT_PATH: "${CI_PROJECT_DIR}/auto-mobile-mcp"
  # Optional: no-ui-perf via env (see JUnit runner README). Dismiss-keyboard uses -D on Gradle below.
  AUTOMOBILE_DAEMON_NO_UI_PERF: "true"

android-ui-tests:
  before_script:
    # Omit if you use a submodule and fetch it before this job.
    - test -d auto-mobile-mcp || git clone --depth 1 --branch ryebread/connection_refused_in_ci_fix https://github.com/kaeawc/auto-mobile.git auto-mobile-mcp
    - cd "${CI_PROJECT_DIR}/auto-mobile-mcp" && bun install && bun run build
  script:
    - ./gradlew -Dautomobile.daemon.dismiss.keyboard.after.input=true :your-module:connectedCheck # or your AutoMobile JUnit task
```

Use **`main`** instead of **`ryebread/connection_refused_in_ci_fix`** after the fix is merged. Adjust paths, Gradle task name, and image (Bun + Android SDK + emulator or ADB session) to match your project.

### 4. Run your existing UI test task

No change to test code is required if you already use the AutoMobile JUnit runner; it will run:

`bun /absolute/path/to/auto-mobile-mcp/dist/src/index.js --daemon restart` (or equivalent) instead of the npm package.

### 5. After the fix is published

Remove the local-checkout env var / system property and rely on the package fallback once you upgrade. Pin the daemon package with **`AUTOMOBILE_VERSION`**, **`AUTOMOBILE_DAEMON_PACKAGE_VERSION`**, or Gradle **`automobile.daemon.package.version`** when CI must use an exact release.

---

## See also

- [Project Setup](project-setup.md) — Gradle config, SNAPSHOT dependency, local dev
- [Writing Tests](writing-tests.md) — `@AutoMobileTest` parameters, YAML plan reference
- [CI daemon logs](ci-daemon-logs.md) — finding and capturing `daemon.log` in CI
- [CI app launch troubleshooting](ci-troubleshooting-app-launch.md) — adb, CtrlProxy, daemon flags, plan assertions
- [CtrlProxy](../control-proxy.md) — Accessibility service setup and version management
