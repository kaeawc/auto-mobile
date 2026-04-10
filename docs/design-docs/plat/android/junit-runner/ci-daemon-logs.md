# Reading the AutoMobile daemon log in CI

Use this when debugging **JUnit / YAML plan** runs that talk to the AutoMobile **daemon** (local checkout via `AUTOMOBILE_DAEMON_LOCAL_PROJECT_PATH` or `bunx @kaeawc/auto-mobile`). The daemon log is the highest-signal place to see **`[LaunchApp]`**, **`CTRL_PROXY`**, **`ConnectionRefused`**, and other server-side errors.

---

## Where the log file is

When the daemon is started through the normal **`--daemon start` / `restart`** flow, AutoMobile creates a **unique directory under `/tmp`** on the **CI runner** (the machine running Gradle), for example:

`/tmp/auto-mobile-daemon-<random>/daemon.log`

Daemon **stdout and stderr** are written to that file.

This is **not** the same path as the Unix socket:

- **Socket (stable):** `/tmp/auto-mobile-daemon-<uid>.sock` (UID = user running the tests, e.g. `id -u` on Linux)
- **Log file (random subfolder):** use **`find`** or the **`Logs:`** line below

---

## How to see the exact path

On a successful daemon start, the parent process often prints to **stderr** a line like:

```text
Logs: /tmp/auto-mobile-daemon-xxxxx/daemon.log
```

Search your **CI job log** for **`Logs:`** if Gradle or the wrapper surfaces stderr.

If that line is missing, locate the file with **`find`** (see below).

---

## GitLab CI: print the log in the job output

Add an **`after_script`** (runs even when tests fail) so the log is visible in the job log:

```yaml
after_script:
  - |
    echo "=== AutoMobile daemon.log (if any) ==="
    find /tmp -maxdepth 4 -name daemon.log -path '*auto-mobile-daemon*' 2>/dev/null | while read -r f; do
      echo "--- $f ---"
      tail -n 500 "$f" || true
    done
```

Adjust **`tail -n`** if you need more lines.

---

## GitLab CI: save logs as a downloadable artifact

Useful when logs are large or you want to attach them to a ticket:

```yaml
artifacts:
  when: always
  paths:
    - daemon-logs/
  expire_in: 3 days

after_script:
  - mkdir -p daemon-logs
  - |
    find /tmp -maxdepth 4 -name daemon.log -path '*auto-mobile-daemon*' -print 2>/dev/null | while read -r f; do
      cp "$f" "daemon-logs/$(basename "$(dirname "$f")").log" || true
    done
```

Download the job artifact and open the `daemon-logs/*.log` files.

---

## GitHub Actions (same idea)

```yaml
- name: AutoMobile daemon log
  if: always()
  run: |
    find /tmp -maxdepth 4 -name daemon.log -path '*auto-mobile-daemon*' 2>/dev/null | while read -r f; do
      echo "--- $f ---"
      tail -n 500 "$f" || true
    done
```

---

## One-off on a shell session

If you have SSH or a debug shell on the same host that ran the daemon:

```bash
find /tmp -maxdepth 4 -name daemon.log -path '*auto-mobile-daemon*' 2>/dev/null
tail -n 200 /tmp/auto-mobile-daemon-XXXXXX/daemon.log
```

---

## Gotchas

- **Same job only:** The log exists on the runner that started the daemon. A **later** CI job does not see that `/tmp` unless you pass an **artifact** or a shared cache (unusual for logs).
- **Ephemeral runners:** `/tmp` may be wiped between jobs—use **`when: always`** and **`after_script`** on the job that runs tests.
- **Enable more noise:** JVM **`automobile.debug=true`** can help surface daemon-related paths and diagnostics in test output; see the JUnit runner README for system properties.

---

## Related

- [Plan failure observation](ci-plan-failure-observation.md) — `failedStep.failureObservation` in JUnit output vs launcher foreground
- [CI app launch troubleshooting](ci-troubleshooting-app-launch.md) — adb verification, CtrlProxy alignment, ui-perf noise, YAML hardening
- [CI Integration](ci-integration.md) — clone/build AutoMobile, env vars, Gradle wiring
