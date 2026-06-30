# Multi-Agent Filesystem Contract

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** The filesystem isolation described here is implemented and covered by tests — per-pid logs with multi-process-safe pruning, age-gated screenshot eviction, and temp-tree cache paths. The operational guidance (per-agent `TMPDIR` + shared-daemon discovery) is a deployment recommendation. See the [Status Glossary](../../status-glossary.md) for chip definitions and [Daemon Overview](index.md) for architecture context.

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

**The recommended production isolation is a per-agent `TMPDIR`** (see §4): give
each agent process its own temp tree so device caches never share a directory at
all, while the shared daemon is still found via the explicit
`AUTOMOBILE_DAEMON_*` paths (which are independent of `TMPDIR`). The code also
applies defense-in-depth so cleanup can't delete a peer's in-flight file even
when `TMPDIR` is shared (see §1 notes).

---

## 1. Ownership model

Writer counts below are for **production (direct mode)** with a **shared
`TMPDIR`**. With a per-agent `TMPDIR` (§4) every per-client row collapses to a
single writer in its own tree.

| Path / resource | Writers (shared TMPDIR) | Collision risk & mitigation |
|---|---|---|
| `${TMPDIR}/auto-mobile/screenshots` | N (every client) | filenames are timestamp-only (not device/pid keyed). Size eviction is **age-gated** (`screenshotCacheEviction.ts`, `SCREENSHOT_MIN_EVICT_AGE_MS`) so it never deletes a peer's recent/in-flight frame. |
| `${TMPDIR}/auto-mobile/observe_results` | N | `observe_<deviceId>_*.json`. Per-device cleanup (`clear(deviceId)`) only touches that agent's own device. `clear()` with **no** deviceId is host-wide — avoid on a shared host, or isolate TMPDIR. |
| `${TMPDIR}/auto-mobile/window` | N | per-device hashed filename — no cross-agent content collision. |
| `${TMPDIR}/auto-mobile/cache` (dumpsys) | N | `dumpsys-window-<deviceId>.json` — per-device. |
| `${TMPDIR}/auto-mobile/cache/screen-size` | N | `md5(deviceId).json` — per-device, content is stable; concurrent writes are idempotent. (No longer CWD-relative.) |
| daemon control socket / PID / lock | 1 (daemon) | discovered by clients via env — see §2. |
| auxiliary sockets (video, snapshot, …) | 1 (daemon) | path depends on `AUTOMOBILE_EMULATOR_EXTERNAL`. |
| `${TMPDIR}/auto-mobile/logs/daemon.log` | 1 daemon | stable daemon log; rotated files are `daemon-<timestamp>.log`. |
| `${TMPDIR}/auto-mobile/logs/stdio-<pid>.log` | 1 each | per-stdio-client file; pruning only trims this pid's files + sweeps stale others by mtime. |
| `${TMPDIR}/auto-mobile/tool_logs` (`LOG_DIR`) | N | routed through `tempDir` (honors `TMPDIR`). |
| `mkdtemp(...)` APK / prefetch / per-start daemon log dirs | per-call unique | **already safe** (random suffix). |

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
# TMPDIR should be PER-AGENT (see §4), NOT shared — it scopes each agent's
# device caches. Daemon discovery does NOT depend on TMPDIR, so isolating it is
# free.
#   export TMPDIR=/run/auto-mobile/agent-$AGENT_ID

# Daemon discovery — MUST match between clients and the daemon, or clients
# resolve a different socket/PID/lock than the daemon created.
export AUTOMOBILE_DAEMON_SOCKET_PATH=/var/run/auto-mobile/daemon.sock
export AUTOMOBILE_DAEMON_PID_FILE_PATH=/var/run/auto-mobile/daemon.pid
export AUTOMOBILE_DAEMON_LOCK_FILE_PATH=/var/run/auto-mobile/daemon.lock

# Container/external-emulator mode flips ALL auxiliary socket paths
# (~/.auto-mobile/*.sock  <->  /tmp/auto-mobile-*.sock). It MUST be the same
# string for clients and daemon. "true" vs unset → different paths → no connect.
export AUTOMOBILE_EMULATOR_EXTERNAL=true   # set on BOTH, or on NEITHER

# Log routing (after the code fix in §4): keep this per-host, not per-client.
export AUTOMOBILE_LOG_LEVEL=warn           # quieter shared log in prod
```

### Why each matters

- **`TMPDIR`** — `tempDir.ts` builds `os.tmpdir()/auto-mobile`. In production
  every client writes the device caches, so a **per-agent `TMPDIR`** (§4) is the
  recommended isolation. If you keep a shared `TMPDIR` instead, the code's
  defense-in-depth (age-gated screenshot eviction, per-pid logs, per-device cache
  cleanup) keeps agents from deleting each other's files.
- **`AUTOMOBILE_DAEMON_*` paths** — `daemon/constants.ts` resolves these at
  module load. Default is `/tmp/auto-mobile-daemon-<uid>.{sock,pid,lock}`. If
  you override them, override them for **both** sides. The daemon already
  propagates non-default values to the child it spawns (`manager.ts` `childEnv`),
  but a *client* that connects must also see the same override.
- **`AUTOMOBILE_EMULATOR_EXTERNAL`** — `getSocketPath()` returns
  `defaultPath` (`~/.auto-mobile/*.sock`) vs `externalPath`
  (`/tmp/auto-mobile-*.sock`) based purely on this var. A client that resolves
  it differently than the daemon looks for auxiliary sockets in the wrong place
  (issues #2446 / #2461). It is read at call time in each process, so it must be
  identical in each process's environment.

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
  The version is **pinned**, not `@latest` (fixed in #2453), so parallel
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
give **each agent its own `TMPDIR`** and point them all at the **same daemon**:

```bash
# Per agent: isolated scratch (device caches, logs never share a directory).
export TMPDIR=/run/auto-mobile/agent-$AGENT_ID

# Same on every agent: the shared daemon is discovered via explicit paths that
# are INDEPENDENT of TMPDIR, so isolating TMPDIR does not fragment the daemon.
export AUTOMOBILE_DAEMON_SOCKET_PATH=/run/auto-mobile/daemon.sock
export AUTOMOBILE_DAEMON_PID_FILE_PATH=/run/auto-mobile/daemon.pid
export AUTOMOBILE_DAEMON_LOCK_FILE_PATH=/run/auto-mobile/daemon.lock
export AUTOMOBILE_EMULATOR_EXTERNAL=...   # identical everywhere (see §2)
```

With this, the only shared filesystem state is the daemon's socket/PID/lock — and
those are explicitly pinned, single-writer, and not derived from `TMPDIR`.

If you instead run all agents under a **shared `TMPDIR`**, the code still avoids
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
  with no deviceId on a shared `TMPDIR`.)

---

## 5. Quick checklist

- [ ] All clients + daemon run as the **same OS user**.
- [ ] **Per-agent `TMPDIR`** (preferred), with explicit `AUTOMOBILE_DAEMON_*`
      paths pointing every agent at the one shared daemon.
- [ ] `AUTOMOBILE_EMULATOR_EXTERNAL` is the **same** value everywhere.
- [ ] If overriding `AUTOMOBILE_DAEMON_{SOCKET,PID,LOCK}_FILE_PATH`, set them
      everywhere.
- [ ] One pinned package version across the fleet.
- [ ] `AUTOMOBILE_LOG_LEVEL` set to keep per-agent log volume sane.
