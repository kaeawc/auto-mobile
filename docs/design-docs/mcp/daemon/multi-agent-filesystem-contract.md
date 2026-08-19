# Multi-Agent Filesystem Contract

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** The filesystem isolation described here is implemented and covered by tests — per-pid logs with multi-process-safe pruning, age-gated screenshot eviction, and data-dir cache paths. The operational guidance (per-agent `AUTOMOBILE_DATA_DIR` + shared-daemon discovery) is a deployment recommendation. See the [Status Glossary](../../status-glossary.md) for chip definitions and [Daemon Overview](index.md) for architecture context.

> **Stable base dir (issue #2724):** All auto-mobile **non-log** on-disk state resolves under a
> **stable, non-ephemeral base directory**, not `os.tmpdir()`. The base is
> resolved by `resolveAutoMobileBaseDir()` (`src/utils/tempDir.ts`):
> `AUTOMOBILE_DATA_DIR` / `AUTO_MOBILE_DATA_DIR` if set → else `~/.auto-mobile` →
> else `os.tmpdir()/auto-mobile` only when no home dir is resolvable. The base is
> deliberately **not** derived from `TMPDIR`/`TMP`/`TEMP`, because `bunx` can point
> those at an extraction tree it later reaps while the daemon still holds open
> fds — the cause of the 0-byte logs and `ENOENT` cache writes in #2724.
> `AUTOMOBILE_LOG_DIR` / `AUTO_MOBILE_LOG_DIR`, when set, overrides only the
> core log directory; otherwise logs use
> `${AUTOMOBILE_DATA_DIR:-~/.auto-mobile}/logs`. Paths written
> `${TMPDIR}/auto-mobile/...` below are historical; read non-log paths as
> `${AUTOMOBILE_DATA_DIR:-~/.auto-mobile}/...`.

## Overview

This document covers how the filesystem and environment behave when **many agents
run in parallel against one shared daemon** on a host.

Deployment shape this document targets:

- **N stdio MCP client processes** (one per agent) on a single host.
- **1 shared AutoMobile daemon** that all clients use for device-pool
  allocation, session/lock coordination, and version reconciliation.
- Each client **executes device tools in its own process** (direct mode). The
  daemon brokers *which* device a client gets; it does not execute that client's
  tools.

> **Proxy mode is for running tests only and is never used in production.** Do
> not reason about production from the proxy-mode (single-writer) model.

The rule that follows from the production shape:

> In production every client process touches devices and writes the device
> caches (`screenshots`, `observe_results`, `window`, `cache`, screen-size,
> dumpsys). These caches are therefore **multi-writer**. Most cache files are
> keyed by `deviceId`, and the daemon hands each session a **distinct** device,
> so file *contents* don't collide between agents. The real hazard is
> **shared-directory cleanup**: a size/age sweep run by one process iterating the
> whole directory can delete another process's files.

**The recommended production isolation is a per-agent `AUTOMOBILE_DATA_DIR`**
(see §4): give each agent process its own auto-mobile base dir so device caches
never share a directory at all, while the shared daemon is still found via the
explicit `AUTOMOBILE_DAEMON_*` paths (which are independent of the data dir). The
code also applies defense-in-depth so cleanup can't delete a peer's in-flight
file even when the data dir is shared (see §1 notes).

---

## 1. Ownership model

Writer counts below are for **production (direct mode)** with a **shared base
dir**. With a per-agent `AUTOMOBILE_DATA_DIR` (§4) every per-client row collapses
to a single writer in its own tree. Paths are written `${TMPDIR}/auto-mobile/...`
for historical continuity; resolve them as
`${AUTOMOBILE_DATA_DIR:-~/.auto-mobile}/...` (see the stable-base-dir note above).
Core log paths below use `$LOG_DIR`, which resolves to
`${AUTOMOBILE_LOG_DIR:-${AUTOMOBILE_DATA_DIR:-~/.auto-mobile}/logs}`.

| Path / resource | Writers (shared base dir) | Collision risk & mitigation |
|---|---|---|
| `${TMPDIR}/auto-mobile/screenshots` | N (every client) | filenames are timestamp-only (not device/pid keyed). Size eviction is **age-gated** (`screenshotCacheEviction.ts`, `SCREENSHOT_MIN_EVICT_AGE_MS`) so it never deletes a peer's recent/in-flight frame. |
| `${TMPDIR}/auto-mobile/observe_results` | N | `observe_<deviceId>_*.json`. Per-device cleanup (`clear(deviceId)`) only touches that agent's own device. `clear()` with **no** deviceId is host-wide — avoid on a shared host, or isolate TMPDIR. |
| `${TMPDIR}/auto-mobile/window` | N | per-device hashed filename — no cross-agent content collision. |
| `${TMPDIR}/auto-mobile/cache` (dumpsys) | N | `dumpsys-window-<deviceId>.json` — per-device. |
| `${TMPDIR}/auto-mobile/cache/screen-size` | N | `md5(deviceId).json` — per-device, content is stable; concurrent writes are idempotent. (No longer CWD-relative.) |
| daemon control socket / PID / lock | 1 (daemon) | discovered by clients via env — see §2. |
| auxiliary sockets (video, snapshot, …) | 1 (daemon) | resolved from the configured/default daemon paths; clients and daemon must agree on explicit overrides. |
| `$LOG_DIR/daemon.log` | 1 daemon | stable daemon log; rotated files are `daemon-<timestamp>.log`. |
| `$LOG_DIR/stdio-<pid>.log` | 1 each | per-stdio-client file; pruning only trims this pid's files + sweeps stale others by mtime. |
| `${TMPDIR}/auto-mobile/tool_logs` | N | routed through `tempDir` (honors `AUTOMOBILE_DATA_DIR`, not `TMPDIR`). |
| `$LOG_DIR/daemon-launch-<pid>.log` | 1 per manager | daemon stdout/stderr launch capture, in the **stable** logs dir (was an ephemeral `mkdtemp(tmpdir())` — issue #2724); truncated per launch. |
| `mkdtemp(...)` APK / prefetch dirs | per-call unique | **already safe** (random suffix). |

The daemon enforces exactly one daemon per host per user (single-daemon policy in
`manager.ts` `startUnlocked`, plus per-UID socket/PID/lock paths), so daemon-owned
rows are single-writer regardless of how clients are configured.

---

## 2. Production env contract

Set these identically for **every** client process *and* in the environment the
daemon is launched from. Mismatches between a client and the daemon are the
single biggest source of "client can't find the daemon" failures.

### Required to be identical across all processes

```bash
# AUTOMOBILE_DATA_DIR should be PER-AGENT (see §4), NOT shared — it scopes each
# agent's device caches and default log location to a stable, non-ephemeral tree. Daemon
# discovery does NOT depend on it, so isolating it is free.
#   export AUTOMOBILE_DATA_DIR=/run/auto-mobile/agent-$AGENT_ID

# Optional: redirect only core logs, without relocating device caches or other state.
#   export AUTOMOBILE_LOG_DIR=/var/log/auto-mobile

# Daemon discovery — MUST match between clients and the daemon, or clients
# resolve a different socket/PID/lock than the daemon created.
export AUTOMOBILE_DAEMON_SOCKET_PATH=/var/run/auto-mobile/daemon.sock
export AUTOMOBILE_DAEMON_PID_FILE_PATH=/var/run/auto-mobile/daemon.pid
export AUTOMOBILE_DAEMON_LOCK_FILE_PATH=/var/run/auto-mobile/daemon.lock

# Log level: keep shared logging volume manageable in production.
export AUTOMOBILE_LOG_LEVEL=warn           # quieter shared log in prod
```

### Why each matters

- **`AUTOMOBILE_DATA_DIR`** — `tempDir.ts` (`resolveAutoMobileBaseDir`) anchors
  the base on `AUTOMOBILE_DATA_DIR` → else `~/.auto-mobile` → else
  `os.tmpdir()/auto-mobile`, and never on `TMPDIR` (which `bunx` may make
  ephemeral — issue #2724). In production every client writes the device caches,
  so a **per-agent `AUTOMOBILE_DATA_DIR`** (§4) is the recommended isolation. If
  you keep a shared base instead, the code's defense-in-depth (age-gated
  screenshot eviction, per-pid logs, per-device cache cleanup) keeps agents from
  deleting each other's files.
- **`AUTOMOBILE_LOG_DIR`** — when set, routes only core daemon/client logs,
  rotated logs, and daemon-launch captures to that directory. It takes
  precedence over the `logs` child of `AUTOMOBILE_DATA_DIR`; all non-log state
  remains data-dir scoped.
- **`AUTOMOBILE_DAEMON_*` paths** — `daemon/constants.ts` resolves these at
  module load. Default is `/tmp/auto-mobile-daemon-<uid>.{sock,pid,lock}`. If
  you override them, override them for **both** sides. The daemon already
  propagates non-default values to the child it spawns (`manager.ts` `childEnv`),
  but a *client* that connects must also see the same override.

### Single-user requirement

`tempDir.ts` creates the base dir with `0o700` (owner-only). All agent client
processes and the daemon **must run as the same OS user**. A second user's
client cannot traverse the first user's `auto-mobile` temp base and its tools
will fail. The per-UID daemon socket/PID/lock names reinforce this: cross-user
sharing of one daemon is not supported. If you need isolation between users,
run **one daemon per user** (each gets its own `<uid>` paths automatically).

---

## 3. Sharing the daemon

- Start the daemon **once** per host/user before fanning out clients, or let the
  first client auto-start it. The atomic lock file
  (`O_CREAT|O_EXCL` in `acquireLock`) already prevents a thundering herd: only
  one client wins the start, the rest `waitForReady`.
- The daemon is spawned via the resolved entry script, falling back to
  `bunx -y @kaeawc/auto-mobile@<pinned-version>` (`resolveDaemonLaunchCommand`).
  The version is **pinned**, not `@latest` (see `resolveDaemonLaunchCommand` in
  `src/daemon/manager.ts` — `@kaeawc/auto-mobile@<version>`; the comment there
  notes `@latest` is not an installable npm tag, so `bunx` must pin), so parallel
  bunx-spawned starts resolve to the same package and the bun install cache is
  not raced across versions. The lock means at most one bunx spawn happens
  anyway. For fully deterministic prod, install the package globally / ship the
  entry script so the `bunx` fallback is never hit, and set `BUN_INSTALL` to a
  warm, shared, read-mostly cache.
- Do **not** run clients from different installed versions against one host
  expecting them to coexist silently — a version mismatch triggers a daemon
  restart (guarded by `DAEMON_VERSION_RESTART_COOLDOWN_MS`). Pin one version
  across the fleet.

---

## 4. Per-agent isolation (the primary production recommendation)

Because every agent executes tools in its own process, the robust setup is to
give **each agent its own `AUTOMOBILE_DATA_DIR`** and point them all at the
**same daemon**:

```bash
# Per agent: isolated, STABLE base dir (device caches, and logs when
# AUTOMOBILE_LOG_DIR is unset, never share a directory and survive bunx
# temp-dir cleanup — issue #2724).
export AUTOMOBILE_DATA_DIR=/run/auto-mobile/agent-$AGENT_ID

# Same on every agent: the shared daemon is discovered via explicit paths that
# are INDEPENDENT of the data dir, so isolating it does not fragment the daemon.
export AUTOMOBILE_DAEMON_SOCKET_PATH=/run/auto-mobile/daemon.sock
export AUTOMOBILE_DAEMON_PID_FILE_PATH=/run/auto-mobile/daemon.pid
export AUTOMOBILE_DAEMON_LOCK_FILE_PATH=/run/auto-mobile/daemon.lock
```

With this, the only shared filesystem state is the daemon's socket/PID/lock — and
those are explicitly pinned, single-writer, and not derived from the data dir.

If you instead run all agents under a **shared base dir**, the code still avoids
cross-agent data loss as defense-in-depth:

- **Logs** are role-scoped (`daemon.log` for the daemon, `stdio-<pid>.log` for
  client processes); pruning only trims this process's files plus stdio logs
  whose owner PID has exited and whose mtime is stale — never another live
  process's current file (`logPruner.ts`).
- **Screenshots** are evicted oldest-first only when over the size cap, and the
  eviction is **age-gated** (`screenshotCacheEviction.ts`) so a peer's recent /
  in-flight frame is never deleted.
- **observe_results / window / dumpsys / screen-size** are keyed by `deviceId`,
  and the pool hands each session a distinct device, so routine per-device
  cleanup only touches that agent's own files. (Avoid the host-wide `clear()`
  with no deviceId on a shared base dir.)

---

## 5. Quick checklist

- [ ] All clients + daemon run as the **same OS user**.
- [ ] **Per-agent `AUTOMOBILE_DATA_DIR`** (preferred), with explicit
      `AUTOMOBILE_DAEMON_*` paths pointing every agent at the one shared daemon.
- [ ] If overriding `AUTOMOBILE_DAEMON_{SOCKET,PID,LOCK}_FILE_PATH`, set them
      everywhere.
- [ ] One pinned package version across the fleet.
- [ ] `AUTOMOBILE_LOG_LEVEL` set to keep per-agent log volume sane.
