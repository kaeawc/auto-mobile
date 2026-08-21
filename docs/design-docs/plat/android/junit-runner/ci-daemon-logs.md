# Reading the AutoMobile daemon log in CI

Use this when debugging **JUnit / YAML plan** runs that talk to the AutoMobile **daemon** (local checkout via `AUTOMOBILE_DAEMON_LOCAL_PROJECT_PATH` or `bunx @kaeawc/auto-mobile`). The daemon log is the highest-signal place to see **`[LaunchApp]`**, **`CTRL_PROXY`**, **`ConnectionRefused`**, and other server-side errors.

---

## Where the log file is

When the daemon is started through the normal **`--daemon start` / `restart`**
flow, AutoMobile writes logs to **`os.tmpdir()/auto-mobile`** on the CI runner
(normally `/tmp/auto-mobile` on Linux). Set `AUTOMOBILE_LOG_DIR` to use another
directory.

The structured daemon log is:

`/tmp/auto-mobile/daemon.log`

The daemon manager also captures the daemon process's stdout and stderr per
launch:

`/tmp/auto-mobile/daemon-launch-<manager-pid>.log`

This is separate from the Unix socket:

- **Socket:** `/tmp/auto-mobile-daemon-<uid>.sock` (UID = user running the tests, e.g. `id -u` on Linux)
- **Log directory:** `${AUTOMOBILE_LOG_DIR:-${TMPDIR:-/tmp}/auto-mobile}`

---

## How to see the exact path

On a successful daemon start, the parent process often prints to **stderr** a line like:

```text
Logs: /tmp/auto-mobile/daemon-launch-12345.log
```

Search your **CI job log** for **`Logs:`** if Gradle or the wrapper surfaces stderr.

If that line is missing, inspect `daemon.log` and `daemon-launch-*.log` in the
log directory (see below).

---

## GitLab CI: print the log in the job output

Add an **`after_script`** (runs even when tests fail) so the log is visible in the job log:

```yaml
after_script:
  - |
    log_dir="${AUTOMOBILE_LOG_DIR:-${TMPDIR:-/tmp}/auto-mobile}"
    echo "=== AutoMobile daemon logs in $log_dir (if any) ==="
    find "$log_dir" -maxdepth 1 -type f -name 'daemon*.log' 2>/dev/null | while read -r f; do
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
    log_dir="${AUTOMOBILE_LOG_DIR:-${TMPDIR:-/tmp}/auto-mobile}"
    find "$log_dir" -maxdepth 1 -type f -name 'daemon*.log' -print 2>/dev/null | while read -r f; do
      cp "$f" daemon-logs/ || true
    done
```

Download the job artifact and open the `daemon-logs/*.log` files.

---

## GitHub Actions (same idea)

```yaml
- name: AutoMobile daemon log
  if: always()
  run: |
    log_dir="${AUTOMOBILE_LOG_DIR:-${TMPDIR:-/tmp}/auto-mobile}"
    find "$log_dir" -maxdepth 1 -type f -name 'daemon*.log' 2>/dev/null | while read -r f; do
      echo "--- $f ---"
      tail -n 500 "$f" || true
    done
```

---

## One-off on a shell session

If you have SSH or a debug shell on the same host that ran the daemon:

```bash
log_dir="${AUTOMOBILE_LOG_DIR:-${TMPDIR:-/tmp}/auto-mobile}"
find "$log_dir" -maxdepth 1 -type f -name 'daemon*.log' 2>/dev/null
tail -n 200 "$log_dir/daemon.log"
```

---

## Gotchas

- **Same job only:** The logs exist on the runner that started the daemon. A **later** CI job does not see `os.tmpdir()` unless you pass an **artifact** or a shared cache (unusual for logs).
- **Ephemeral runners:** The default temporary directory may be wiped between jobs—use **`when: always`** and **`after_script`** on the job that runs tests.
- **Enable more noise:** JVM **`automobile.debug=true`** can help surface daemon-related paths and diagnostics in test output; see the JUnit runner README for system properties.

---

## Related

- [CI Integration](ci-integration.md) — clone/build AutoMobile, env vars, Gradle wiring
- [Diagnosing daemon MCP connectivity](diagnosing-daemon-mcp-connectivity.md) — socket path, health check, transport errors
