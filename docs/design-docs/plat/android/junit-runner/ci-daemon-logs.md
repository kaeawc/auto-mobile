# Reading the AutoMobile daemon log in CI

Use this when debugging **JUnit / YAML plan** runs that talk to the AutoMobile
**daemon**. The daemon log is the highest-signal place to see `[LaunchApp]`,
`CTRL_PROXY`, `ConnectionRefused`, and other server-side errors.

## Choose the artifact directory before starting AutoMobile

Set `AUTOMOBILE_LOG_DIR` to an absolute directory that the current CI job can
upload directly. Do not rediscover the default after a failure: path and home
directory semantics differ across Linux, macOS, Windows, containers, and
service accounts.

AutoMobile creates the configured directory when it initializes logging. It
writes these files there:

- `daemon.log` — structured daemon output
- `daemon-launch-<manager-pid>.log` — detached daemon stdout and stderr

Without an override, logs remain under the resolved AutoMobile data directory,
normally `~/.auto-mobile/logs`.

## GitLab CI

```yaml
variables:
  AUTOMOBILE_LOG_DIR: "$CI_PROJECT_DIR/daemon-logs"

after_script:
  - |
    for log_file in "$AUTOMOBILE_LOG_DIR"/daemon*.log; do
      [ -f "$log_file" ] || continue
      echo "--- $log_file ---"
      tail -n 500 "$log_file" || true
    done

artifacts:
  when: always
  paths:
    - daemon-logs/
  expire_in: 3 days
```

## GitHub Actions

Set the variable at job scope so every process that can start or restart the
daemon inherits the same destination:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      AUTOMOBILE_LOG_DIR: ${{ github.workspace }}/daemon-logs
    steps:
      # Build and test steps go here.
      - name: Upload AutoMobile daemon logs
        if: failure()
        continue-on-error: true
        uses: actions/upload-artifact@v4
        with:
          name: auto-mobile-daemon-logs
          path: daemon-logs/
          if-no-files-found: ignore
```

`github.workspace` is an absolute native path on Windows as well as on Unix
runners, so the runtime and artifact action use the same value without a shell
path conversion.

## One-off shell inspection

If you have a shell on the host that ran the daemon and did not set an
override, inspect the normal default:

```bash
ls -la "${HOME}/.auto-mobile/logs"
tail -n 200 "${HOME}/.auto-mobile/logs/daemon.log"
```

On successful managed starts, stderr also includes the exact launch capture:

```text
Logs: /home/ci/.auto-mobile/logs/daemon-launch-12345.log
```

## Gotchas

- Logs exist on the runner that started the daemon. Upload them from the same
  job.
- Put `AUTOMOBILE_LOG_DIR` at job or process scope, not only on the final test
  command: setup and helper processes may start the daemon first.
- JVM `automobile.debug=true` can surface additional daemon diagnostics in test
  output; see the JUnit runner README for system properties.

## Related

- [CI Integration](ci-integration.md) — clone/build AutoMobile, env vars, Gradle wiring
- [Diagnosing daemon MCP connectivity](diagnosing-daemon-mcp-connectivity.md) — socket path, health check, transport errors
