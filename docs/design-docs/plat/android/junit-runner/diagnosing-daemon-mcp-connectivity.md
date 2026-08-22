# Diagnosing daemon MCP connectivity (CI)

**In MkDocs:** Android → JUnitRunner → **Diagnosing daemon MCP connectivity**.

Use this when JUnit reports **`Unable to connect. Is the computer able to access the url?`** (often with **`AutoMobile plan execution failed with exit code 1`**) even though **`adb devices`** shows a device and plan YAML was composed on the JVM side.

---

## What it usually means

The JUnit runner talks to the AutoMobile **daemon** over a **Unix domain socket**. The daemon forwards tool calls (including `executePlan`) to the in-process MCP server over **HTTP on loopback** (`http://<host>:<port>/…`).

That inner HTTP hop uses the runtime’s **`fetch`**. If it cannot connect, the socket response fails with a short error message like the one above—**before** your YAML steps run. This is **not** the same as the app under test failing to reach its API (e.g. staging URLs).

When the daemon log includes **`Full error: {"code":"ConnectionRefused",…}`**, that is **ECONNREFUSED**: nothing accepted TCP on the address `fetch` used (often **`localhost` → IPv6 `::1`** while the HTTP server is only on **IPv4 `127.0.0.1`**, or the reverse). Retrying after a few hundred milliseconds does **not** fix that class of failure.

**Noise to ignore:** If you also see **`Device pool initialization timed out after 5000ms`** even though the log already says the device pool initialized successfully, that was a **stale timer** in older daemon builds (fixed by clearing the timeout after the race completes).

---

## Recommended diagnosis order

### 1. Read the daemon log (highest signal)

When **`automobile.debug=true`** (or your CI already prints it), stderr often includes:

- **`Logs: /home/ci/.auto-mobile/logs/daemon-launch-….log`**

Open that file on the failed job artifact or add a step to **`cat`** it after tests. Look for:

- **`Error forwarding request to MCP server`** — confirms the failure is the **HTTP MCP client**, not ADB or YAML.
- The **stack trace** immediately after that line.

If you do not have the path in stderr, inspect **`$AUTOMOBILE_LOG_DIR`** when
configured, or **`~/.auto-mobile/logs`** by default. For CI, set the variable
before AutoMobile starts and upload that exact directory as described in
[CI daemon logs](ci-daemon-logs.md).

### 2. Check proxy environment variables

On many CI runners, **`HTTP_PROXY`**, **`HTTPS_PROXY`**, **`http_proxy`**, or **`https_proxy`** are set. Some stacks route **`http://localhost:…`** through the proxy; the proxy cannot reach the job’s own loopback → connection errors that look like “unable to access the url”.

In the same job (before Gradle), log (redact secrets if needed):

```bash
env | sort | grep -i proxy || true
```

**Mitigation to try:** ensure loopback is excluded, for example:

- Set **`NO_PROXY=localhost,127.0.0.1,::1`** (and often **`no_proxy`** to the same) for the process that starts the daemon / Gradle test worker, **or**
- Unset proxy variables for the test step only.

Re-run the job and see if `executePlan` proceeds.

### 3. Verify loopback HTTP from the runner shell

While the daemon is up (or in a one-off debug job), from the same user/environment as tests:

```bash
curl -svS "http://127.0.0.1:3000/auto-mobile/streamable" -o /dev/null 2>&1 | head -40
```

Adjust **port** and path if your daemon logs show a different **`MCP_STREAMABLE_PATH`**. If **`curl`** cannot connect, fix networking/bind/proxy before chasing app or YAML issues.

### 4. Rule out IPv4 vs IPv6 `localhost` mismatch

If **`localhost`** resolves to **`::1`** but the HTTP server is only listening on **`127.0.0.1`** (or the reverse), `fetch` can fail. Prefer **`127.0.0.1`** consistently in daemon host configuration and in any manual checks.

### 5. Only after the above: plan and device

If the daemon log shows **`executePlanTool`** / plan steps progressing, then investigate YAML, CtrlProxy/APK, and **`AUTOMOBILE_CTRL_PROXY_APK_PATH`** as described in [CI Integration](ci-integration.md).

---

## Trying the fix before an npm release

The **IPv4 loopback default** and related fixes live in this repo’s **`dist/`** output. You do **not** have to wait for **`@kaeawc/auto-mobile`** on npm if CI can run a **built checkout**:

1. Add the **auto-mobile-mcp** repo to your pipeline (submodule, `git clone`, or copy job artifact).
2. In that checkout run **`bun install`** (if needed) and **`bun run build`** so **`dist/src/index.js`** exists.
3. Point the JUnit runner at that tree with **`AUTOMOBILE_DAEMON_LOCAL_PROJECT_PATH`** or Gradle **`automobile.daemon.local.project.path`** (documented in **`android/junit-runner/src/main/kotlin/dev/jasonpearson/automobile/junit/README.md`** in this repo).

The runner will then start **`bun <path>/dist/src/index.js --daemon …`** instead of the package fallback.

**Released package without upgrading:** there is **no** supported env-only workaround for **`ConnectionRefused`** on **`localhost`** today; fixing it requires a build that defaults the daemon HTTP host to **`127.0.0.1`** (or passing **`--host 127.0.0.1`** through **`--daemon start`/`restart`** on a version whose entrypoint forwards **`--host`** to **`--daemon-mode`**).

---

## See also

- [CI Integration](ci-integration.md) — emulator.wtf, env vars, CtrlProxy APK
- Daemon architecture: [Daemon](../../../mcp/daemon/index.md) (design-docs)

---

## Implementation reference (for maintainers)

| Piece | Location in repo |
|-------|------------------|
| Unix socket → MCP HTTP endpoint | `src/daemon/socketServer.ts` (`StreamableHTTPClientTransport`, `createMcpClient`) |
| HTTP server listen address / port | `src/daemon/daemon.ts` (`mcpEndpoint`, `startHttpServer`) |
| JUnit prints **`Daemon error:`** | `android/junit-runner/.../AutoMobilePlanExecutor.kt` |
