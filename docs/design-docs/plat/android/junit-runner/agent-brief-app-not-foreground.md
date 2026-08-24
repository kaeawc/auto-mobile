# Agent brief: app not staying foreground (AutoMobile CI)

**Audience:** IDE agents and app engineers debugging **host app** behavior when AutoMobile JUnit tests report odd failures in CI or locally.

**Symptoms (often together):**

- `launchApp` returns **success**, but the **launcher** (e.g. Nexus Launcher) stays focused.
- **`daemon.log`** shows the foreground package as **`com.google.android.apps.nexuslauncher`** (or another launcher), not your `applicationId`.
- **`observe`** can still **pass** while the wrong screen is visible (valid snapshot ≠ your app’s UI).
- Later steps (`tapOn`, `waitFor`) **fail** because elements exist only in your app.
- **`failedStep.failureObservation`** in the plan result shows **launcher `packageName`** at failure time.

**Goal:** Decide whether the problem is **your APK / activity lifecycle** (crash, immediate finish, wrong component) vs **test plan assertions** that allow the launcher. Collect evidence the app team can act on.

---

## What a narrow CI logcat already proves

Some pipelines only archive logcat filtered to **activity / task** lines (e.g. `ActivityTaskManager`). That is enough to see **intents and transitions**, and often enough to see **CtrlProxy** working.

It is **usually not enough** to answer: _why did my process disappear or never hold focus?_

If the saved logcat has **no** lines like:

- `FATAL EXCEPTION`
- `AndroidRuntime`
- `Process … has died`
- `SecurityException` / `IllegalStateException` tied to your package

…then you are **not missing a hidden line inside that same file**. You need **wider logcat** or **`dumpsys`** captured in the **same time window** as the failure (or reproduce locally with the same APK).

---

## Evidence to collect (priority order)

**New vs old file:** `adb logcat -c` clears the **device’s** ring buffer, then you launch and `adb logcat -d` **dumps a fresh capture** from that session. That does **not** modify or append to an existing CI logcat artifact—you are generating **new** text to save or paste. For the same APK behavior as CI, use the **same build** (flavor, signing, env) and the **same emulator/API level** when possible.

**Beyond logcat:** steps **1–3** are **`pidof` / `dumpsys`** (not logcat). Keep them in the same bundle you share—they often explain focus/stack when logcat is still noisy.

**If correlating with a CI failure:** still attach **`daemon.log`** (or the CI line that points to it) and **JUnit / Gradle** failure output so the timeline matches; the adb block above is for **device-side** root cause.

Use the same **application id** your YAML plan uses (`appId`). Replace **`PACKAGE`** below (e.g. `com.example.app`).

### 1. Process still alive after launch

```bash
adb wait-for-device
adb shell pidof PACKAGE
```

- **Empty output:** process is not running (crash, immediate `finish()`, or never started correctly).

### 2. What window actually has focus

```bash
adb shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'
```

- If the line shows a **launcher** package instead of **`PACKAGE`**, your app is not the focused window—even if `am start` / `launchApp` appeared to succeed.

### 3. Activity stack (optional but high signal)

```bash
adb shell dumpsys activity activities | head -n 200
```

Search the output for **`PACKAGE`** and the top **`Resumed`** / **`mResumedActivity`** section. This shows whether your activity **resumed** and what sits above it in the stack.

### 4. Broader logcat (this is the main gap vs narrow CI captures)

Clear, launch once, then dump errors:

```bash
adb logcat -c
adb shell monkey -p PACKAGE -c android.intent.category.LAUNCHER 1
sleep 3
adb logcat -d '*:E' 'AndroidRuntime:E' 'ActivityManager:I' 'WindowManager:I' | tail -n 200
```

If your package has a known **log tag**, also run (replace **`YourTag`**):

```bash
adb logcat -d | grep -E 'AndroidRuntime|FATAL|PACKAGE|YourTag' | tail -n 120
```

**Look for:** the **first** stack trace or fatal error mentioning your package after launch.

### 5. PID-scoped logcat (when the process exists briefly)

Right after launch, try:

```bash
PID=$(adb shell pidof PACKAGE | tr -d '\r')
test -n "$PID" && adb logcat --pid="$PID" -d | tail -n 150
```

If `pidof` is empty, skip this and rely on step **4** (wide logcat).

---

## After a fresh run: what you are looking for

There is **no single canonical filename** CI must produce. What matters is that you saved **plain text** for each command (upload as job artifacts, or paste into a ticket). Treat that bundle as one “evidence package.”

**1. `pidof` output (step 1)**

- **Good for debugging:** a **numeric PID** (process still alive a moment after launch).
- **Smoking gun:** **empty** → app is not running; pair with logcat for crash vs silent exit.

**2. `mCurrentFocus` / `mFocusedApp` lines (step 2)**

- **Good:** your **`PACKAGE`** appears on the focus line.
- **Problem:** **launcher** or another package → explains why AutoMobile still “sees” launcher UI even after `launchApp`.

**3. Wide logcat (step 4, and step 5 if you had a PID)**  
Scan top-to-bottom for the **first** occurrence of any of:

- `FATAL EXCEPTION` (especially with your package or `AndroidRuntime` below it)
- `AndroidRuntime: E` stack traces
- `Process <your.package> has died` (wording varies by API)
- `SecurityException`, `IllegalArgumentException`, `IllegalStateException` mentioning your code

That block (a few dozen lines around the first hit) is usually **the** artifact you hand to the app team.

**4. `dumpsys activity` excerpt (step 3)**  
Use when logcat is clean but focus is wrong: find **`mResumedActivity`** / **`Resumed`** and whether your **`ActivityRecord`** appears, **finished**, or sits under a dialog/overlay.

**5. Still running AutoMobile tests**  
Keep **`daemon.log`** + **JUnit/Gradle** failure snippet from the **same** run so you know which plan step failed and what the daemon thought the foreground app was.

**Bottom line:** you are looking for **actionable text**: either a **crash stack** in logcat, or **focus/stack** proof that your activity never resumed or exited immediately—saved as files or logs you can link, not a specific proprietary “artifact type.”

---

## How this maps to fixes

| Finding                                                   | Likely area                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `FATAL EXCEPTION` / `AndroidRuntime` for **your** package | App bug (startup crash, missing dep, migration, etc.)                                  |
| `SecurityException` / permission denial                   | Manifest, runtime permissions, or device policy                                        |
| `pidof` empty, no crash in logcat                         | Immediate `finish()`, wrong launcher activity, or process name / user profile mismatch |
| Focus stays on launcher, app process alive                | Overlay, dialog, or another activity on top—investigate stack (step **3**)             |
| Focus wrong, tests still “observe”                        | **Harden the YAML** (next section)                                                     |

---

## Harden AutoMobile YAML (parallel track)

Treat **`launchApp` success** as _start was attempted_, not _your UI is visible_.

Immediately after `launchApp`, wait for something **only your app** can show (resource id including your package):

```yaml
- tool: launchApp
  appId: PACKAGE
  label: Start app

- tool: observe
  label: Wait for app-specific chrome
  waitFor:
    elementId: "PACKAGE:id/your_main_view"
    timeout: 15000
```

`waitFor` must include **`text`** or **`elementId`** (not timeout alone). See [Writing Tests → observe](writing-tests.md).

---

## Full AutoMobile / CI context

- [CI app launch troubleshooting](ci-troubleshooting-app-launch.md) — CtrlProxy alignment, daemon flags, `daemon.log`, emulator checks outside AutoMobile
- [CI daemon logs](ci-daemon-logs.md) — capturing **`daemon.log`** from CI

When sharing with an agent, attach: **CI job excerpt**, **`daemon.log`**, **JUnit failure**, and the artifacts from steps **1–4** above (plus step **5** when `pidof` returns a PID) from the **same** failing run or a local repro with the **same APK**.
