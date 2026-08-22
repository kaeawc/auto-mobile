# CI troubleshooting: app launch, CtrlProxy, and YAML plans

Use this after you have [daemon logs](ci-daemon-logs.md) and still see **`launchApp` succeeding** while the **launcher stays foreground**, **`observe` “passing”** on the wrong screen, **CtrlProxy checksum** warnings, or **`J.create is not a function`** / performance-audit noise in the daemon log.

The steps below are ordered: confirm the app really runs on the device, remove version skew for CtrlProxy, quiet optional daemon features while debugging, then tighten plans so assertions cannot match the launcher.

### What to capture

Grab **everything you can** from the same failing CI run; each source answers a different question.

| Source | What it shows | Use it for |
|--------|----------------|------------|
| **CI job log** | Gradle, stderr lines like **`Logs: …/daemon.log`**, step ordering, env | First signal: *what* failed and whether the daemon log path was printed |
| **`daemon.log`** | `[LaunchApp]`, CtrlProxy, MCP tool errors, timeouts | *How* AutoMobile drove the device and what the daemon rejected |
| **JUnit / Gradle test output** | Failed test class, failed plan step, runner messages | *Which* YAML step failed and how the JUnit runner reported it |
| **`failedStep.failureObservation`** (in `executePlan` JSON / JUnit failure blob) | Full hierarchy at failure time (`packageName`, nodes) | *What* was on screen when the step failed (launcher vs your app) |
| **`logcat` (device)** | `FATAL EXCEPTION`, `AndroidRuntime`, stack traces for your package | *Why* the app exited or never held the foreground |

**Reading order:** CI log + JUnit output → **`daemon.log`** → **`logcat`** (or reproduce launch locally with adb if CI did not save logcat). If you only keep two artifacts, prefer **`daemon.log`** and **`logcat`** (or CI log if logcat is unavailable).

See [CI daemon logs](ci-daemon-logs.md) for configuring and uploading the
directory that contains **`daemon.log`**.

---

## 1. Confirm the app on the emulator (outside AutoMobile)

Goal: decide whether the failure is **your app crashing** vs **AutoMobile mis-reporting**.

### 1.1 Install and start like CI does

Use the same APK and package your plan uses (`appId`). Replace **`PACKAGE`** with the application id (e.g. `com.example.app`).

```bash
adb wait-for-device
adb install -r path/to/your-app-debug.apk

# Launch default MAIN/LAUNCHER activity without hard-coding the activity class
adb shell monkey -p PACKAGE -c android.intent.category.LAUNCHER 1
```

Alternative if you know the activity component:

```bash
adb shell am start -W -n PACKAGE/.YourLauncherActivity
```

### 1.2 Is the process alive?

```bash
adb shell pidof PACKAGE
```

If this prints **nothing** (exit code 1 / empty), the process exited—usually a **crash** or immediate finish.

### 1.3 What is actually in the foreground?

```bash
adb shell dumpsys window | grep mCurrentFocus
```

If you see **`com.google.android.apps.nexuslauncher`** (or your OEM launcher) instead of **`PACKAGE`**, the app is not the focused window even if `am start` returned quickly.

### 1.4 First crash signal in logcat

Clear logcat, reproduce the launch once, then read errors (adjust `PACKAGE`):

```bash
adb logcat -c
adb shell monkey -p PACKAGE -c android.intent.category.LAUNCHER 1
sleep 3
adb logcat -d | grep -E "AndroidRuntime|FATAL|PACKAGE" | tail -n 80
```

Look for the **first** `FATAL EXCEPTION` or `AndroidRuntime` stack trace for your package. That stack is what you fix in the app (missing native lib, bad migration, etc.)—not in the YAML plan.

### 1.5 Optional: one-off CI step

You can add the **`pidof`** / **`mCurrentFocus`** / **`logcat`** lines as a **debug step before** `./gradlew …test` in the same job that has `adb` pointed at your emulator session. Remove the step once the root cause is clear.

---

## 2. Align CtrlProxy (APK) with the AutoMobile daemon

Goal: avoid **prefetch checksum mismatch** followed by a **different** APK (e.g. from **`releases/latest`**) than the one your **daemon build** expects.

### 2.1 Prefer a single source of truth

| Approach | What to do |
|----------|------------|
| **In-tree (this repo)** | Build CtrlProxy in CI and set **`AUTOMOBILE_CTRL_PROXY_APK_PATH`** to `android/control-proxy/build/outputs/apk/debug/control-proxy-debug.apk` (see [CI Integration](ci-integration.md) and [Project Setup](project-setup.md)). |
| **Pinned release** | Download a **specific** GitHub release asset (not `latest` if you care about reproducibility) and point **`AUTOMOBILE_CTRL_PROXY_APK_PATH`** at that file. For checksum expectations, the published values live in AutoMobile’s **`src/constants/release.ts`** (`APK_URL`, `APK_SHA256_CHECKSUM`) for tagged releases. |
| **Skip checksum only in dev** | Empty or “skip” checksum behavior is for local convenience; in CI, prefer **matching** URL + SHA or a **locally built** APK from the same commit as the daemon. |

### 2.2 Verify after install

```bash
adb shell pm path dev.jasonpearson.automobile.ctrlproxy
```

If the package is missing, the service cannot supply hierarchy to **`observe`** reliably.

### 2.3 Daemon vs CtrlProxy

The **daemon** (Node/Bun) version and the **CtrlProxy** APK should come from the **same release or same git revision** when possible. Mixing an unpinned daemon package with a **cached** or **manually downloaded** CtrlProxy APK is a common source of subtle mismatches.

---

## 3. Turn off UI performance mode while debugging

When **`--ui-perf-mode`** is enabled, the daemon runs extra performance / audit paths. While debugging unrelated launch or hierarchy issues, that noise (for example errors involving **`J.create`**) can obscure the real failure.

The CLI flag to disable it is **`--no-ui-perf-mode`** (see [feature flags](../../../mcp/feature-flags.md)).

### 3.1 JUnit runner flags for daemon `start` / `restart`

`DaemonSocketPaths` appends optional CLI flags when the runner spawns the daemon:

| Flag | Env var | System property |
|------|---------|-------------------|
| **`--dismiss-keyboard-after-input`** | — | `automobile.daemon.dismiss.keyboard.after.input=true` |
| **`--no-ui-perf-mode`** | `AUTOMOBILE_DAEMON_NO_UI_PERF` (`true` / `1` / `yes`) | `automobile.daemon.no.ui.perf.mode=true` |

Set these in CI (and/or pass `-D…` on the Gradle CLI) so a **`--daemon restart`** uses the same options as a manual pre-start.

### 3.2 Practical CI pattern: pre-start the daemon

If the Unix socket **already exists**, the runner **reuses** the running daemon instead of spawning a new one.

1. In the same job, **before** `./gradlew …test`, start the daemon once with ui-perf off, using the **same** startup style as your runner (local checkout **or** package):

**Local checkout (matches `AUTOMOBILE_DAEMON_LOCAL_PROJECT_PATH`):**

```bash
export AUTOMOBILE_DAEMON_LOCAL_PROJECT_PATH="${CI_PROJECT_DIR}/auto-mobile-mcp"
bun "${AUTOMOBILE_DAEMON_LOCAL_PROJECT_PATH}/dist/src/index.js" --daemon start --no-ui-perf-mode
```

**Published package (matches `bunx` / `npx` fallback):**

```bash
bunx @kaeawc/auto-mobile@<version> --daemon start --no-ui-perf-mode
```

2. Run Gradle tests as usual.

3. **Important:** If your Gradle **`Test`** task sets **`automobile.daemon.force.restart`** to **`true`** (this repo’s **`:junit-runner`** module does for its own tests), the runner **restarts** the daemon and **drops** your pre-started process. For this debugging pattern, **remove or override** that system property for the run (e.g. `-Dautomobile.daemon.force.restart=false` on the Gradle CLI if your build allows it).

4. After debugging, remove the pre-start and restore your normal daemon flags.

---

## 4. Harden YAML plans after `launchApp`

### 4.1 Why `observe` can “lie”

A plain **`observe`** step **succeeds** whenever the device returns a valid snapshot. If your app **crashed** and the **launcher** is showing, **`observe` still succeeds**—so the plan can advance and **`tapOn`** / **`waitFor`** targets never match your app.

A step with **`waitFor`** may still be treated as **successful** in the plan executor even when the wait **timed out** (`awaitTimeout: true`) in some daemon versions—so **`PLAN_STEP_N observe completed. Response success: true`** is not always proof the condition held. When available, prefer **`failedStep.failureObservation`** on the final error to see the **actual** tree at failure time.

### 4.2 Prefer app-specific assertions

Right after **`launchApp`**, assert something **unique to your app**, not strings that also exist on the launcher:

```yaml
- tool: launchApp
  appId: com.example.app
  label: Start app

- tool: observe
  label: Wait for app-specific chrome
  waitFor:
    elementId: "com.example.app:id/main_content"
    timeout: 15000
```

Use **`elementId`** (resource id including your package) when possible; it fails fast if the launcher is still foreground.

### 4.3 `waitFor` rules

You must supply **`text`** or **`elementId`** inside **`waitFor`** (not timeout alone). See [Writing Tests → observe](writing-tests.md).

### 4.4 Mental model

Treat **`launchApp` returning success** as “start was attempted,” not “your activity is visible and stable.” Combine **`launchApp`** with a **discriminating** **`observe` + `waitFor`** (or fix the underlying crash from §1) before steps that assume your UI is on screen.

---

## Related

- [Agent brief: app not foreground](agent-brief-app-not-foreground.md) — **shareable** short playbook for app/IDE agents (`pidof`, `dumpsys`, wide logcat, YAML `waitFor`)
- [CI daemon logs](ci-daemon-logs.md) — capture `daemon.log` in GitLab / GitHub
- [CI Integration](ci-integration.md) — emulator.wtf, `AUTOMOBILE_CTRL_PROXY_APK_PATH`, Gradle wiring
- [Diagnosing daemon / MCP connectivity](diagnosing-daemon-mcp-connectivity.md) — socket and local checkout
- [Writing Tests](writing-tests.md) — full YAML tool reference
