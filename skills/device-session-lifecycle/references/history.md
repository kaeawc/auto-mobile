# Device Session Lifecycle — Bug History Catalog

Compiled 2026-08-20 from GitHub issues/PRs (through PR #5419, merged
2026-08-20) and past working sessions. Organized by era, then cross-indexed
by bug class. Use this to check whether a "new" bug is a recurrence and to
find the canonical fix pattern.

## Era 1 — Session model origins (autolock, ~#2300–2700)

| Item          | Bug                                                                            | Root cause                                                                                                      | Fix                                                                                                     |
| ------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| PR #2328      | Device-aware calls routed to arbitrary device under autolock                   | Guard only covered multiple-iOS case                                                                            | `enforceSessionUuidForAutolock`: require sessionUuid/deviceId when autolock on and >1 candidate         |
| #2387 → #2419 | installApp success but app absent for launchApp                                | install resolved device via session, launch via platform → two different simulators                             | One shared resolution path                                                                              |
| PR #2421      | Repeated startDevice for a bound device failed                                 | Non-autolock startDevice minted a competing UUID that failed binding (regression from #2419)                    | Reuse the live session — startDevice idempotent                                                         |
| #2443         | Device held ~30s when client dies pre-first-heartbeat                          | grace (20s) + heartbeat timeout (10s) before reclaim                                                            | Shorter pre-first-heartbeat grace                                                                       |
| #2444         | Client hangs on "ready" daemon                                                 | Readiness inferred from PID/socket-file existence                                                               | Positive-signal readiness: connect + health request                                                     |
| #2445 → #2455 | Phantom devices wedge discovery until daemon restart                           | `refreshDevices()` only added, never removed; idle entries never liveness-checked                               | Bidirectional reconcile, prune idle                                                                     |
| #2599         | Daemon restart wedges every MCP client ("Session not found")                   | Socket sessions are per-daemon-process; proxy retries didn't re-register                                        | Treat as recoverable: teardown, reconnect, re-register, retry once (typed transport failures, PR #2739) |
| #2732         | Wrong-build daemon serves frontend ("Unknown tool")                            | One socket per uid shared by all checkouts; version gate compared identical strings; tool cache not invalidated | Build-identity handshake (PR #2749), self-heal on unknown tool                                          |
| #2638         | DisconnectMonitor churns on removed devices + resurrects user-killed emulators | Stale recording refs; miss counters re-counted; warm-up re-boots killed emulators                               | Clear refs, stop re-warning, don't auto-resurrect                                                       |
| #2663         | —                                                                              | —                                                                                                               | Repo rule: UUIDs only via injected `IdGenerator`, never raw `randomUUID()`                              |

## Era 2 — Boot correctness (#3300–4000)

| Item                | Bug                                                                   | Root cause                                                                                                                                                 | Fix                                                  |
| ------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| #3334               | "Booted" before OS finished booting; installApp fails "still booting" | Three "already running" fast paths had zero readiness check; Android missed `sys.boot_completed` gating; iOS `simctl list` shows Booted before SpringBoard | Readiness checks on fast paths                       |
| #3393 → #3397/#3401 | Cold-boot returns wrong deviceId + false isReady with ≥2 emulators    | Name-match fallback picked the _first_ running emulator when the new one hadn't attached to adb                                                            | Correlate cold boot to the actual launched emulator  |
| #3552 → #3554       | Dead emulator kept being assigned                                     | Pool never evicted on process/adb disappearance                                                                                                            | Evict on exit/disappearance                          |
| #3553 → #3555       | Stale idle iOS UDIDs assigned                                         | No liveness validation pre-assignment                                                                                                                      | Validate simulator liveness                          |
| #3938 → #3941/#3945 | Command timeouts orphan simctl/emulator/xcodebuild children           | Timeout killed the promise, not the child                                                                                                                  | Kill child on timeout                                |
| #3952 → #3954       | Hung boot leaks a half-started device                                 | Readiness failure didn't cancel the start handle                                                                                                           | Auto-cancel via `handle.kill()`                      |
| #3110               | XCTestRunner "Daemon failed to start within 10000ms"                  | 10s readiness budget too small on cold macOS runners                                                                                                       | Budget/warm-up ordering                              |
| #3877/#3943 → #3944 | videoRecording "bare stop" flaked on macOS CI                         | Module-level singleton let the real file-backed DB be resolved                                                                                             | Inject narrow device detector + real-DB guard        |
| #3640               | CI daemon-lifecycle script false-green                                | pipeline exit code lost                                                                                                                                    | `PIPESTATUS` fix in `scripts/ci/daemon-lifecycle.sh` |

## Era 3 — Managed sessions, recovery, capability lifecycle (#4600–5250)

| Item                            | Bug                                                                                       | Root cause                                                                                                                                                       | Fix                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| #4610/#4611 → #4626/#4634/#4655 | Capability profiles leaked/bypassed; released plan sessions kept enforcing stale profiles | TTL-guess for release; explicit-deviceId bypass; routing vs capability session conflated                                                                         | `SessionReleaseBroadcaster` + `notifications/session/released` push; enforcement on every path       |
| #4914 → #4915                   | Emulator dies mid-session → pool empty forever                                            | Detect-and-remove only; `PooledDevice` didn't retain avdName                                                                                                     | Opt-in same-AVD recovery for pool-owned emulators                                                    |
| #4974 → #4978                   | All boot failures collapse into generic 120s timeout                                      | No failure-class detection                                                                                                                                       | Detectors: mprotect/HVF, stuck-offline, tiny-RAM AVD, outdated cmdline-tools                         |
| #4979 → #4980                   | Session routing vs mutable active-device unsafe for concurrent clients                    | `setActiveDevice` is global mutable state                                                                                                                        | Bind MCP connection to a pool session at startup; recovery env vars; setActiveDevice = legacy compat |
| #4753 → #4888                   | Orphaned `adb forward` entries accumulate                                                 | Server-side expiry didn't clean host forwards                                                                                                                    | Sweep orphaned forwards                                                                              |
| #5202                           | startDevice hangs full 180s on modern AVDs                                                | Arch probe ran a real boot (`-verbose`, 3s timeout, SIGKILL) → stale `hardware-qemu.ini.lock` → "multiple emulators with same AVD" misread as "already starting" | Read ABI from `config.ini`; verify "already starting" registers in adb                               |
| #5237 → #5238                   | Session returned before automation runner ready; first observes fail                      | Readiness at OS-boot boundary, not automation boundary                                                                                                           | Runner readiness inside startDevice budget; phase-labeled ActionableErrors                           |
| #4992/#4999                     | Transient adb `offline` failed readiness                                                  | Offline treated as terminal                                                                                                                                      | Tolerate transient offline                                                                           |
| #4989 → #5245                   | WHEP capture lanes red at daemon bring-up on hosted runners                               | Readiness budget vs runner cold start                                                                                                                            | Bring-up hardening                                                                                   |

## Era 4 — Lifecycle audit + DeviceSessionRegistry (#5256–5419)

Systematic audit at main@312a1680 produced coded findings (START/SESS/DISC/
RECV/SHUT), each an issue+PR pair:

| Finding  | Issue → PR                                                 | Bug                                                                                                             | Fix pattern                                                                    |
| -------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| SESS-01  | #5287 → #5339                                              | Expiry removed session but left device busy (release callback only handled autolock)                            | Expiry retires session + pool ownership together                               |
| SESS-02  | #5288 → #5343                                              | Heartbeat cleanup reaped sessions with active executions                                                        | Active executions block reaping                                                |
| SESS-03  | #5289 → #5338                                              | Partial multi-device rollback released devices but left sessions                                                | Owner-checked rollback removes every created session                           |
| SESS-04  | #5290 → #5348                                              | Delayed duplicate release cleared a reassigned device                                                           | Every release names expected owner; stale releases ignored                     |
| SESS-05  | #5291 → #5342                                              | Concurrent same-UUID `getOrCreateSession` reserved two devices                                                  | Recheck existence after acquiring assignment mutex                             |
| SESS-06  | #5292 → #5341                                              | In-memory ownership mutated before awaited persistence; repo failure left ghost-busy                            | Restore invariants on persistence failure                                      |
| DISC-02  | #5294 → #5315                                              | killDevice success on `adb emu kill` ack, before exit or retire                                                 | Bounded 30s wait for disappearance; retire before success; incarnation-checked |
| RECV-01  | #5296 → #5323                                              | Startup discovery raced its 5s timeout; late resolution overwrote live assignments                              | Timed-out discovery can't overwrite; owner-preserving refresh                  |
| SHUT-03  | #5302 → #5326                                              | stdin close called `process.exit(0)`, skipping async shutdown                                                   | One idempotent bounded shutdown on stdin end/error/close                       |
| SHUT-04  | #5303 → #5327                                              | Graceful shutdown never released active sessions; keep-awake settings lost                                      | Shutdown releases via canonical teardown, persists terminal state              |
| START-03 | #5281 → #5359                                              | External abort not raced against non-cooperative boot phases                                                    | Abort rejects every phase; late settlement can't bind                          |
| START-05 | #5283 → #5358                                              | Concurrent same-AVD starts: null-handle adopter binds first, owner's cleanup kills shared emulator              | Single lifecycle owner; transfer forbids post-transfer kill                    |
| —        | #5295 → #5317                                              | Async `setInterval` monitors overlapped ticks                                                                   | `SingleFlightInterval` on injected Timer                                       |
| —        | #5276→#5360, #5297→#5325, #5280, #5282, #5284–#5286, #5298 | Readiness/recovery long tail: lost diagnostics, un-terminated children on cancel, unbounded readiness ADB calls | Bounded deadlines, child termination, diagnostics persistence                  |

**DeviceSessionRegistry epic #5256** (no wire-protocol backward compat —
daemon and desktop ship together):

- #5257 → PR #5265 (keystone): `DeviceSessionRegistry` mints
  `deviceSessionUuid` per device connection epoch, keyed on
  `PooledDevice.incarnation`; idempotent per incarnation; in-memory only.
  In-PR fixes: retire gated on `!devicePool.getDevice(deviceId)` (else
  same-serial auto-recovery churns the just-minted epoch); startup mint done
  in the daemon's `initializeDevicePool` path because `initializeWithDevices`
  is deliberately a silent pre-populate. Latent footgun: `DaemonState
.initialize` defaults its registry param — a 2-arg caller silently gets a
  throwaway registry.
- #5266 → #5313: retire was asymmetric (only disconnect monitor fired it);
  refresh eviction / liveness / idle-pruning bypassed it → stale entries.
  Fix: `onDeviceRemoved` listener on `DevicePool.removeDevice`, the single
  `devices.delete` choke point; also mint for devices present at startup.
- #5267 → #5340: fast same-serial reconnect before miss threshold kept the
  old incarnation → two adb epochs aliased to one UUID. Fix: `transportId`
  in pool runtime identity.
- **#5369 → #5372: regression from #5340** — cold boot built
  `expectedIdentity` without transportId; `undefined !== 23` → identity
  mismatch on every Android cold boot, emulator torn down. Fix: unknown
  transportId is a wildcard. **Not caught by unit tests** (needed live adb
  transport timing).
- #5258 → #5365: multiplexed subscriptions — `subscriptionId` echoed on
  subscribe and stamped on every frame (backfill included);
  unsubscribe/update_cadence per-subscription; pong/close/error
  per-connection; keepalive one ping per socket. (Pre-existing: five
  socket-keyed break-after-first-match loops made a second subscription on
  one socket unreachable.)
- #5259 → #5407: stamp `deviceSessionUuid` on every stream envelope +
  `device_session_started/ended` lifecycle frames. Filter rule: null = all
  devices; retired uuid matches nothing (explicit backfill guard); unknown
  provenance ⇒ uuid null ⇒ all-device subscribers only (kills #4837
  navigation cross-contamination). Skew hazard: old deviceId-only subscribe
  against new daemon silently becomes all-devices. Discovery contract:
  enumerate `daemon/listDeviceSessions` first; boot-time devices emit no
  started frame. Wire doc: `docs/design-docs/mcp/daemon/client-screen-control.md`
  (doc-coupling tests exist).
- Open: #5260 (push-socket auth + registration-only sessions + ownership
  re-auth revoking foreign subscribers), #5262 (desktop DaemonStreamHub),
  #5263 (workspace state keyed on deviceSessionUuid).

**Bound-session fencing:**

- #5411 → #5412: a bound MCP transport's session expired during normal agent
  think-time (tool activity updated `lastHeartbeat` but not
  `hasReceivedHeartbeat`; the stdio proxy never sent `daemon/heartbeat`),
  and lookup could _recreate_ the expired UUID against a different device.
  Fix: proxy heartbeats at 2s while bound; released identities terminally
  fenced (`session_ownership_lost`, machine-readable, never silent rebind);
  diagnostic release reasons (`missing-first-heartbeat`,
  `heartbeat-timeout`).

**PR #5419 (merged 2026-08-20) — "harden lifecycle recovery":**

- Explicit daemon restart force-stops live AutoMobile daemon-mode processes
  from other PID-file namespaces even when the configured socket is
  unreachable (orphaned cross-namespace daemons could block replacement);
  ordinary start stays non-destructive; fails closed on unrelated processes.
- Reinstalls device-session stream routing after recovery.
- Rejects malformed/unresolved UUID subscriptions without polling unrelated
  devices; session-scoped navigation updates.
- Preserves plan ownership, session rebind activity/label state, and
  device/session incarnation identity through shutdown and deferred cleanup.
- Files: daemon.ts, daemonMcpProxy.ts, deviceDataStreamSocketServer.ts,
  devicePool.ts, manager.ts, sessionManager.ts, deviceTools.ts,
  executionTracker.ts + 13 test files.

**Related same-week:** #5414 (independent log dir override), #5415
(screenshot EEXIST collision under concurrent same-device capture), #5416
(desktop restarts newer daemon at compatible version), #5376 → #5389 (30s
runner-readiness budget vs ~85s cold CtrlProxy launch — fixed by CI
_ordering_, not budget inflation), #5248/#5393 (macOS runner contention
flake classification).

## Cross-index: bug class → instances

1. **Release/teardown asymmetry**: #2445, #5266, #5287, #5302, #5303
2. **ABA / stale actor**: #5289, #5290, #5296, #5283, (#5369 as the
   identity-tightening regression)
3. **Success before observable effect**: #2387, #3334, #3393, #5237, #5294
4. **Identity by mutable key**: #3393, #5267, #5369, epic #5256
5. **Heartbeat vs liveness**: #2443, #5288, #5411
6. **Un-owned children / side-effect probes**: #3938, #3952, #5202, #5297,
   #5298
7. **Readiness budget vs cold start**: #3110, #5376, #4989
8. **Daemon process identity/replacement**: #2444, #2599, #2732, #5419
