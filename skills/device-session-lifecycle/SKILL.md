---
name: device-session-lifecycle
description: "Hunt, fix, and prevent device session lifecycle bugs in AutoMobile: startDevice/killDevice, device session UUIDs, boot readiness, daemon start/stop/restart, session expiry/release, pool state races, and flaky lifecycle tests. Use when a bug involves sessions binding to the wrong device, devices stuck busy/idle/ghost, boot or shutdown hangs, daemon churn or 'Session not found', stream frames routed to the wrong device, or when designing/reviewing changes to devicePool, sessionManager, deviceSessionRegistry, deviceTools, or the daemon proxy."
---

# Device Session Lifecycle — Hunting & Fixing

The device session layer is where AutoMobile has shipped the most regressions.
The bug classes repeat; the fixes that stuck follow a small set of patterns.
This skill encodes both, plus the invariants any change must preserve.

Line refs are against main @ 2026-08-20 (post PR #5419). They drift — verify
with grep before citing. Full bug history: `references/history.md`.

## 1. Four identifiers, three lifecycles — never conflate them

| Identifier               | Minted by                                                                                                             | Meaning                                                                                                                                                  | Persisted                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `sessionUuid`            | `IdGenerator` in startDevice (`src/server/deviceTools.ts`), autolock (`src/daemon/devicePool.ts`), or client-supplied | **Who is driving**: client/test session owning one device; caches, tool-selection profile                                                                | yes (`device_sessions` table)           |
| `deviceSessionUuid`      | `src/daemon/deviceSessionRegistry.ts`                                                                                 | **One device connection epoch**: minted per pool incarnation, retired on disconnect, re-minted on reconnect even for the same serial. Stream routing key | no — meaningless across daemon restarts |
| `__mcpSessionId`         | socket-server connection / MCP transport                                                                              | Per-connection transport identity; implicit autolock resolution                                                                                          | no                                      |
| `deviceId` (serial/UDID) | adb / simctl                                                                                                          | Human label + adb target only. **Mutable across reboots — never an identity key**                                                                        | n/a                                     |

Three lifecycles overlap: (A) pooled device (`PooledDevice.status` +
`incarnation` in `devicePool.ts`), (B) device-session epoch (registry),
(C) MCP/pool session (`sessionManager.ts`). Plus the daemon process itself
(`manager.ts` / `DaemonLauncher.ts`). Historic conflations: #2599 ("Session
not found" = transport session, not pool session), #5411 (pool session
rebind), the #5256 epic (epoch identity was missing entirely).

`incarnation` (bumped only at pooled-entry **creation**) is the sole thing
distinguishing "same serial, new boot" from "same device", and since #6863 it
is the ONLY epoch token in the model — the ADB transport id is gone from
`BootedDevice`/`PooledDevice`, and discovery carries nothing else. Anything
identity-sensitive must be keyed on the incarnation; runtime identity is
validated by serial + platform + name, and a boundary is observed as
**disappearance then reappearance** — the pool evicts an entry the moment
discovery stops listing the serial and re-adds it under a fresh incarnation.

**`Unknown (<serial>)` means "no information", uniformly.** It is the
placeholder Android discovery emits when the emulator console did not answer
`avd name`, and it is guarded by `isAndroidEmulatorSerial` (a handset's name is
`ro.product.model`, so handsets keep serial-only identity). The same rule
applies in all three places the name is read:

1. **Comparing observations** (`deviceTools.isSameBootedDeviceIdentity` /
   `isConfirmedDeviceReplacement`): never evidence of a replacement AND never
   evidence of continuity — the two predicates are deliberately not each
   other's negation. During shutdown, a still-listed serial whose name probe
   stopped answering is the same device still present, so the wait runs on to
   real absence; only a RESOLVED, different name declares a replacement.
2. **Destructive actions** (`killDevice`, `deleteDevice`): the pooled AVD label
   must be confirmed by the runtime (`AndroidEmulatorClient.resolveRunningAvdName`,
   bounded by the CALLER's remaining teardown/kill deadline — never an
   independent timer). A different name refuses; an unanswered probe also
   refuses (`target_identity_unresolved`), naming `adb -s <serial> emu kill` as
   the manual escape. There is no fail-open branch. A tool-level `force` option
   for an emulator whose console is wedged is tracked as a separate follow-up.
3. **Publishing identity** (`DevicePool.describesPooledRuntime`, the booted-devices
   resource): the placeholder is not agreement, so the resource withholds BOTH
   the pooled epoch (`connectionId` falls back to the bare serial) and the
   pooled AVD label (`stableId` falls back to discovery's own name). The pool's
   internal `matchesRuntimeIdentity` still TOLERATES the placeholder so an
   unreadable console never evicts a live entry — tolerance is not agreement.

**The pool state that carries the rule: `PooledDevice.identityUnresolved`.**
When any discovery observes the placeholder on a LIVE entry, the pool quarantines
that entry instead of choosing between two wrong answers. The entry
is kept — same session, same `incarnation` — but:

- **assignment** — the shared gate `ensurePooledDevicePresentForUse` reports it
  as not assignable, so `selectAssignableIdleDevice` skips it AND the
  exact-device paths (`bindOrReuseDeviceSession`, autolock, both via
  `validateOrReloadIdlePooledDevice`) refuse with an error naming the serial.
  This covers the entry the assignment's OWN liveness check just quarantined:
  the operation that ENTERS the quarantine fails at assignment rather than
  returning a session that then fails every tool;
- **tool execution** — FUNNEL 2, `DevicePool.assertDeviceActionable`, refuses,
  naming the serial and the pooled AVD label. `assertSessionReadyForAutomation`
  is one CALLER of it, not the gate itself;
- **publishing** — `describesPooledRuntime` reads the state, so the resource
  publishes no pool context;
- **destructive confirmation** — `deviceTools.getValidatedPooledAndroidAvdName`
  returns undefined, so no destructive path can act on the cached label —
  including the stopped-image inventory path in `deleteDevice`, which previously
  bypassed the unresolved-runtime guard on the strength of that label. Dropping
  the label is not enough for a KILL, because it also drops the confirmation the
  label exists to trigger: a quarantined entry produces its own `quarantined`
  capture kind whose runtime confirmation is MANDATORY (an unanswered console or
  a differing name refuses), and `AndroidEmulatorClient.killDevice` refuses when
  both the requested and the discovered name are the placeholder — two unknowns
  are not an equality;
- **in-flight work** — entering the quarantine cancels and drains the bound
  session's already-registered executions through the injected
  `cancelDeviceSessionExecutions` seam (the one the ADB-reset quarantine uses).
  The admission gate only refuses LATER calls; an execution already in flight
  keeps issuing serial-addressed operations. The session and the `incarnation`
  survive — only the work is stopped. ONE execution is exempt: the one whose own
  discovery produced this observation, named by the caller through
  `DiscoveryReconcileOptions.excludeExecutionId`. A session-bound `killDevice` or
  `deleteDevice` can be the first path to read the placeholder on its own target,
  and cancelling it would lose the `runWithinShutdownDeadline` signal race for the
  operation about to confirm-or-refuse on exactly that evidence. The post-cancel
  drain takes the same exemption, so it does not spend its budget waiting on work
  it deliberately did not cancel;
- **stream routing** — the daemon builds its `DeviceSessionResolver` over the
  pool quarantine, so a quarantined serial has NO routing identity in either
  direction (serial→uuid and uuid→serial), and each push server
  (observation/hierarchy, telemetry, performance, failures) drops that serial's
  device-attributed frames instead of broadcasting them to all-device
  subscribers — logged once per quarantine, not once per frame. The registry
  record is untouched underneath, so lifting the quarantine resumes the SAME
  `deviceSessionUuid`; a replacement instead mints a new incarnation, whose uuid
  routes while the retired one stays unresolvable.

**Two funnels enforce this structurally — there is no per-site gating left.**

- **FUNNEL 1, `DevicePool.reconcileDiscoveryObservation(devices, source)`.** Every
  path that discovers Android devices and then consults pooled identity folds its
  observation in here FIRST: the refresh sweep and the assignment-time liveness
  check (inside the pool), and — through the `daemon/discoveryReconcile.ts`
  wrapper or the socket server's own private helper — the disconnect monitor, the
  booted-devices resource, `listDevices`, the shutdown/kill preflight, the
  teardown precondition, pre-boot serial validation, the Android start lifecycle
  target, `provisionDevice`'s exact-boot discovery, the socket server's
  input-target and `ide/*` routes, and the two capture resolvers that run their
  own discovery (`resolveWebRtcStreamDevice` and `resolveVideoStreamDevice` —
  without reconciling, BOTH of their admission checks re-read pool state from
  before the discovery they just performed). Device-addressed MCP resource reads (storage,
  databases, DataStore, app data, app files, localization, shared storage,
  storage capabilities) all go through one `src/server/resourceDeviceResolver.ts`
  that reconciles: they are not exempt, because resolving a serial and then
  reading that runtime IS acting on a pooled identity, whatever the read
  publishes. Reconciling is also not the END of a request: the booted-devices
  resource skips `enrichDeviceServiceStatuses` / `enrichDeviceLockStates` for a
  serial its own reconciliation just quarantined and publishes that entry with
  discovery-only identity plus `identityUnresolved: true`, rather than probing a
  runtime it has just said it cannot identify. It is idempotent (an observation
  that already
  `describesPooledRuntime` only advances the entry's ordering stamp), takes no
  lock, and changes no pool
  MEMBERSHIP: a disagreement reaching it is quarantined and left for the paths
  that own allocation to settle. Before it, a read that was the first to see the
  placeholder withheld only its OWN output while the pool went on trusting the
  stale label.
- **FUNNEL 2, `DevicePool.assertDeviceActionable(deviceId, purpose)`.** Every
  device-addressed operation passes it, WITH OR WITHOUT a session. It is enforced
  at the SEAM, not per entry point: enumerating entry points never finished,
  because each review round found another route that reached a device without
  crossing the one just gated — the legacy sessionless tool path when autolock is
  disabled, MCP resource reads, a stream resolver's own fresh discovery, each
  target an all-device fan-out expands to.

  The seam is **binding a serial to a device client**, which every Android
  device-addressed operation does exactly once:
  `AdbClientFactory.create(device)` and — because it memoizes per serial —
  `AndroidCtrlProxyClient.getInstance(device)`. Both call the gate through
  `daemonDeviceAdmissionGate` (`src/daemon/deviceAdmissionGate.ts`), which is a
  no-op in direct mode, where there is no pool. Android-only is complete coverage
  rather than a gap: `hasReusableSerial` restricts the quarantine to Android
  emulator serials, because an iOS UDID is never reused. The one exception is
  `unadmittedAdbClientFactory`, used ONLY by `AndroidEmulatorClient` — the
  identity, lifecycle and teardown machinery that must reach a quarantined serial
  precisely because it is quarantined (discovery reading the AVD name is the only
  event that can LIFT the quarantine; `emu kill` is how the pool settles a serial
  it can no longer identify).

  The daemon-boundary gates are KEPT on top of the seam, because they refuse
  earlier and with a purpose-specific message rather than because the seam needs
  them: `assertSessionReadyForAutomation` (the session spelling),
  `runTrackedDeviceInput` ahead of its sessionless early return (tap, swipe,
  typeText, button, key, gestures), `request_observation` in the device-data
  stream server (which refuses BEFORE observing, instead of acking `success:
true` after pushing zero frames), the `ide/*` device-addressed routes, the
  raw-serial `subscribe_storage` target, every target an all-device
  `subscribe_storage` expands to (`Daemon.applyStorageSubscriptionRequest`, which
  reports the refused targets so the request is not acked as complete), and the
  capture servers — video-stream `subscribe`, `webrtcStream` `start` and
  `testRecording` `start`. Authorization is NOT this gate: the quarantine
  deliberately preserves the owning session, so an authorized subscribe or start
  still passes it and would capture whichever replacement AVD now answers on the
  serial. The push servers reach the gate through the `DeviceSessionResolver`
  they already hold; the capture and recording servers, which hold no pool
  reference, take the narrower `DeviceAdmissionGate` instead. Teardown spellings
  are deliberately exempt — refusing an unsubscribe or a stop would strand
  device-side state this daemon registered.

An all-device `request_observation` names no serial for the gate to preflight,
so the same false acknowledgement is prevented on the way out instead: a
quarantined device is reported as a per-device failure (alongside the
missing-hierarchy ones) rather than pushed into the routing black hole and acked
`success: true`.

The enforcement is two lint tests, not review attention:
`test/lint/deviceDiscoveryReconcileFunnel.test.ts` inventories every discovery
call site in `src/` with a count and a reason and fails on a new one, and
`test/lint/deviceAddressedAdmissionGate.test.ts` pins the seam — that both device-
client resolutions gate, and that only `AndroidEmulatorClient` reaches the
unadmitted factory — and fails on a device-addressed socket handler that does not
reach the gate.

Leaving the quarantine is decided by the next discovery that READS a name: the
pooled label (or the AVD this pool started) restores the entry unchanged, and a
different name is a replacement — a fresh incarnation, the old session retired,
exactly as an observed disappearance. Handsets never enter the state.

**Only NEWER evidence moves it, in either direction.** Discovery calls run
concurrently and finish out of order, so an older listing can land after a newer
one. `PooledDevice.identityObservedAt` records the `observedAt` of the newest
identity observation folded into the entry — the placeholder or disagreement that
ENTERED the quarantine, and the resolved name that confirmed or lifted it — and a
strictly older stamped observation is ignored before BOTH transitions. Recording
it only on the quarantine transitions made the rule one-sided: a straggler could
not lift a newer quarantine, but a delayed placeholder could still quarantine an
entry a newer observation had just resolved, cancelling the bound session's
in-flight executions on evidence the pool already knew was superseded. This is
the same newer-wins ordering the pool applies to mutable-name updates through
`nameObservedAt`. Unstamped observations stay unorderable and transition as
before, so a legacy caller cannot wedge an entry in either state.

**A disagreement only leaves the quarantine through the replacement actually
installing.** `replacePooledDeviceForRuntimeIdentity` installs it by evicting the
old incarnation, and `evictMissingPooledDevice` DEFERS eviction while killDevice
holds a shutdown reservation — so the refresh reloads the very entry the
discovered runtime disagrees with. Reconciling there would read the disagreeing
name as proof of continuity; instead that entry is quarantined (and its metadata
left alone) until the replacement installs. The rule in one line: the quarantine
lifts on an identity MATCH, never on a differing name.

**The teardown's own discovery is authoritative over the pool's label.** Its
observation now reaches the pool through FUNNEL 1 before anything reads pool
state, so the entry is quarantined by that very observation. `deleteDevice`'s
unresolved-runtime guard still reads its OWN observation rather than
`getValidatedPooledAndroidAvdName`: a booted emulator this discovery cannot name
refuses the stopped-image inventory path outright. The destructive path is the
one consumer that MATCHES through the quarantine
(`getBootedAndroidTeardownStableName`), because refusing there would make the
mandatory runtime confirmation — a strictly stronger gate — unreachable and drop
the teardown back onto the inventory path it exists to prevent.

**Documented blind spot**: a same-serial restart faster than one discovery
interval never reaches the pool, so it reads as continuity. Every host-side
cache keyed on the epoch must therefore SELF-HEAL on failure (evict and rebuild
once before surfacing the error — see the append-helper cache in
`src/daemon/socketServer.ts`), and any destructive action that would act on a
pool-cached AVD name must re-resolve it from the runtime first
(`AndroidEmulatorClient.resolveRunningAvdName`, used by killDevice/deleteDevice)
and refuse when that re-resolution does not answer — and that confirmation runs
BEFORE the shutdown's preparation side effects (stopping recordings, closing the
CtrlProxy singleton, detaching observers), so a refusal leaves a still-running
device fully intact.

**Self-heal on HELPER failure, never on a RUNNER verdict.** The two outcomes are
distinguished by the result type (`AppendTextFailureSource`), never by inspecting
`charsSent === 0`:

- the helper itself failed (threw, transport error, stale cached helper) → evict,
  rebuild once, retry. With a confirmed prefix the retry resumes the unconfirmed
  SUFFIX and carries NO validator (the original validation was already spent and
  the prefix has advanced the runner's frame epoch); with nothing confirmed it
  retries the whole text WITH the original validator, because nothing was
  validated-and-sent yet;
- the RUNNER returned a verdict (`success: false`, e.g. a stale `frameContext`)
  → surface it as-is. No rebuild, no replay: the helper worked, and replaying
  would type into a UI the runner explicitly refused.
  Historical entries in `references/history.md` that reason about `transportId`
  (e.g. #5372) describe the pre-#6863 model; do not reintroduce the field.

## 2. Invariants (the contract every fix must preserve)

1. **Epoch identity**: `deviceSessionUuid` = one device connection epoch.
   Mint idempotent per incarnation; fresh mint on reconnect even with an
   identical serial; mint correctness must never depend on retire having
   fired (#5257).
2. **Retire symmetric with mint**: every removal path (refresh eviction, idle
   pruning, liveness check, kill, recovery, shutdown) must retire — hang
   listeners off the single choke point `DevicePool.removeDevice` (#5266).
   Gate retire on the device actually being gone (`!getDevice`), or
   same-serial recovery churns UUIDs.
3. **One bound client ↔ one session ↔ one device.** A session UUID must never
   silently resume against a different device. Released identities are
   terminally **fenced**: machine-readable `session_ownership_lost` error,
   never a rebind (#5411/#5412). Bound MCP proxies heartbeat at 2s.
4. **Every release names its expected owner**; stale releases are ignored,
   repeats idempotent (#5348). Sessions with active executions are not reaped
   (#5343). Expiry retires session + pool ownership together (#5339).
5. **startDevice readiness is the automation boundary, not OS boot**: a
   returned session is observe-ready (CtrlProxy installed + healthy) or fails
   with a phase-labeled ActionableError inside one absolute deadline
   (#5237/#5238). startDevice is idempotent for an already-bound device
   (#2421). Fast "already running" paths still verify readiness (#3334).
6. **killDevice succeeds only after confirmed disappearance + ownership
   retire** (bounded 30s), incarnation-checked so a fast same-ID replacement
   isn't destroyed (#5315).
7. **Session release is a pushed signal, not a TTL guess**: all releases fan
   out through the SessionManager choke point → `SessionReleaseBroadcaster` →
   `notifications/session/released`; TTLs are only a backstop (#4655).
8. **Stream routing**: null filter = all devices; frames for unresolvable
   devices carry uuid `null` and reach only all-device subscribers; a
   retired uuid matches nothing (no fall-through to backfill). Consumers
   enumerate `daemon/listDeviceSessions` first, then rely on
   `device_session_started/ended` frames — boot-time devices emit no started
   frame (#5259/#5407).
9. **Under autolock with >1 candidate, untargeted device-aware calls are
   rejected** — sessionUuid or explicit deviceId required (#2328).
10. **Recovery** only touches AutoMobile-owned virtual devices; default 2
    attempts; env-configured at daemon startup
    (`AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS`, `..._MAX_ATTEMPTS`) (#4915/#4979).
11. **Monitors are single-flight** (`SingleFlightInterval` on an injected
    Timer) — no overlapping ticks (#5317). Daemon shutdown releases sessions
    through canonical teardown and restores keep-awake best-effort (#5327);
    stdin close runs the same bounded async shutdown, never `process.exit`
    (#5326).
12. **Daemon replacement**: ordinary start is non-destructive; only explicit
    restart force-stops live daemon-mode processes from other PID-file
    namespaces, and fails closed on unrelated processes (#5419). Readiness is
    a positive signal (connect + health), never PID/socket-file existence
    (#2444).
13. `setActiveDevice` global routing is legacy compat only; session-bound
    routing is the model (#4979). No backward compatibility on the
    daemon↔desktop wire protocol — they ship together (#5256); a skewed old
    client silently becomes an all-devices subscriber (privacy leak).
14. UUIDs come only from the injected `IdGenerator` — never `randomUUID()`
    at call sites (#2663).
15. **An in-flight AVD launch is first-class; the AVD-name label is not
    evidence about liveness.** `AndroidEmulatorClient.startEmulator` claims the
    AVD in a process-wide registry before it spawns and releases the claim in a
    `finally`, so two launches of the same AVD in one process can never both
    reach the spawn. After the spawn, the console-port reservation carries the
    AVD identity: a listed `Unknown (emulator-NNNN)` whose serial matches a
    reservation this process holds for that AVD counts as "already starting
    here". A mid-boot emulator is unnamed for ~4s on a snapshot resume and for
    minutes on a cold boot, and the `${os.tmpdir()}/avd/running/pid_*.ini`
    advertisement (`RunningAvdAdvertisementReader`) does not exist at all on
    macOS/Apple silicon — so it is a **secondary** signal only, never the guard.
    The scan behind the guard uses `getBootedDevicesChecked`: an adb discovery
    failure surfaces as an error and must never be read as "not running"
    (#6407, child of #6371).

## 3. Recurring bug classes → where to look first

1. **Release/teardown asymmetry** — acquire is centralized, release is bolted
   onto one call site; alternate paths leak state (ghost-busy devices, stale
   registry entries). Smell: state cleaned in one handler but N removal
   paths exist. Grep all callers of the acquire; diff against callers of the
   release. (#2445, #5266, #5287, #5303, #5326)
2. **ABA / stale actor clobbers replacement** — delayed release, discovery
   timeout, or callback lands after reassignment. Smell: any `await` between
   read and mutate of pool/session maps without an expected-owner or
   incarnation guard. (#5290, #5296, #5289, #5283; regression risk: #5369)
3. **Success before the observable effect** — "booted" before boot_completed,
   killDevice success on `adb emu kill` ack, install success on the wrong
   simulator. Smell: success derived from a command's ack, not from
   ground-truth polling. (#3334, #3393, #5294, #2387, #5237)
4. **Identity by mutable key** — serial/UDID used where an incarnation or
   epoch UUID belongs. Smell: `deviceId` in a map key for anything
   longer-lived than one call. (#3393, #5267, #5369, epic #5256, #6863)
5. **Heartbeat bookkeeping vs real liveness** — grace windows,
   `hasReceivedHeartbeat`, agent think-time gaps. Smell: expiry math with two
   clocks or two flags. (#2443, #5288, #5411)
6. **Un-owned children / probes with side effects** — emulator, simctl,
   xcodebuild processes outliving timeouts; a "probe" that actually boots
   (#5202's `-verbose` probe left a stale `hardware-qemu.ini.lock`). Smell:
   spawn without kill-on-timeout/abort; timeout that kills the promise, not
   the child. (#3938, #3952, #5297)
7. **Readiness budget vs cold-start reality** — every new bounded budget is
   eventually exceeded by a cold CI runner. Fix by warm-up **ordering**, not
   budget inflation. (#3110, #5376)
8. **Daemon process identity** — clients holding state about a replaced
   daemon: stale tool caches, "Unknown tool", wedged transports, orphaned
   cross-namespace daemons blocking replacement. (#2599, #2732, #2444, #5419)

## 4. Hunting procedure

1. **Classify the identifier** involved (table §1) before anything else.
   Most misdiagnoses start by chasing the wrong session concept.
2. **Rule out environment artifacts** (all documented, all reproduce as
   "bugs"):
   - `Session not found` right after a daemon restart → #2599 transport
     wedge, not a session bug. Confirm with a second unrelated tool call.
   - Competing worktree daemons on the shared socket
     (`/tmp/auto-mobile-daemon-<uid>.sock`) cause build-skew rejects and
     flag loss — kill strays, re-check (see `skills/manual-test/SKILL.md`
     Phase 2).
   - The DisconnectMonitor may auto-restart an emulator you killed by hand.
   - Stale dist masked by the version string — verify by build hash / dist
     mtime, never `0.0.x+g<sha>`.
3. **Ground truth, never the `success` flag**: `adb -s <id> emu avd name`,
   `getprop sys.boot_completed`, `adb get-state`, `xcrun simctl list`,
   process table for emulator children, `adb forward --list` for orphaned
   forwards. Daemon log: grep `ensureDeviceReady`, `session_ownership_lost`,
   release reasons (`heartbeat-timeout`, `missing-first-heartbeat`,
   `device-stopped:`, `device-disconnected:`), `need download`.
4. **Drive via the build-matched CLI** when proxy skew is possible:
   `bun dist/src/index.js --cli <tool> --<param> <value>`.
5. **Reproduce the race deterministically in a unit test** with the injected
   seams (`FakeTimer`, `FakeIdGenerator`, fake pool/clients) before fixing —
   the repo's races are all await-interleavings, and every landed fix in
   this area ships with a test that forces the interleaving.
6. **Check the weak-spot map (§6)** — if your symptom touches one of those
   sites, read the surrounding invariant comments first; several say
   explicitly "do not 'fix' this by adding a barrier".

## 5. Fix patterns that stuck / anti-patterns

**Stuck:**

- Single choke point + listeners: route all removals through
  `DevicePool.removeDevice`, all releases through `SessionManager`, and hang
  cross-cutting concerns (registry retire, broadcast) off them.
- Expected-owner compare-and-act on every mutation; incarnation guards with
  unknown-field-as-wildcard.
- Bounded absolute deadline sliced per phase (`DeviceBootService.runPhase`),
  abort raced against every phase, 1s settlement grace, child killed on
  timeout.
- Positive readiness signals at the consumer's boundary.
- `SingleFlightInterval` for periodic work; re-validate state after every
  await in unlocked paths.
- Structured, machine-readable errors (`session_ownership_lost`,
  `device_already_stopped`, phase-labeled ActionableErrors).

**Anti-patterns (each caused a real regression):**

- Widening a mutex / adding a barrier to "fix" ordering — breaks the
  shutdown drain contract (see warnings in `sessionManager.ts`).
- Tightening identity matching without a wildcard for fields older callers
  don't populate (#5369).
- Inflating a readiness budget instead of reordering warm-up (#5376).
- A probe that boots (#5202); success from an ack (#5294).
- Retire/cleanup that assumes the device is gone without checking whether
  recovery already re-created it.
- Growing a base class surface casually — the typecheck baseline's
  "…and N more" counts are sensitive to it.

## 6. Weak-spot map (highest bug density first)

- `src/server/deviceTools.ts` ~:594-772 — killDevice late-retirement trio
  compensates for uncancellable release; 1s post-release recheck window can
  miss a slow same-ID replacement.
- `src/daemon/devicePool.ts` — 3.6k-line god object. Known soft spots:
  intentional-shutdown gating is incarnation-scoped on disconnect but
  serial-scoped on recovery; `removeDisconnectedDevice` runs outside
  `assignmentMutex` (re-validate after each await); shutdown-reservation
  release bypasses the mutex by design; two independent miss-debounce
  policies (refresh threshold 2 vs monitor 3×5s); hard-coded 60×1s
  assignment retry loop.
- `src/daemon/daemonMcpProxy.ts` ~:426-468 — five interacting bound-session
  caches, each from a distinct in-flight-release bug. Highest-complexity
  invariant surface in the repo.
- `src/daemon/daemon.ts` — disconnect cleanup re-checks staleness three
  times per iteration (each await can invalidate); DB left open if session
  releases don't drain in 5s; pool init capped at 5s but not cancelled.
- `src/daemon/sessionManager.ts` — 1s caps on setup drain / keep-awake
  restore overflow into `pendingDeviceCleanup` quarantine the pool must
  honor; two "do not add a barrier" comments.
- `src/utils/android-cmdline-tools/AndroidEmulatorClient.ts` ~:2004-2360 —
  readiness main loop shares mutable state with a detached background
  poller; fatal child exit can be observed then re-armed; "multiple
  emulators with same AVD" is swallowed (can attach readiness to another
  process's emulator).
- `src/daemon/manager.ts` + `constants.ts` — readiness probe retry (3×150ms)
  exists because one failed probe used to unlink a healthy daemon's socket
  ("dominant cause of devices-not-found after restart"); lockfile takeover
  has a documented double-race; 10s startup budget vs 5s discovery + 5s/iOS
  CtrlProxy warmup.
- `src/daemon/daemonFiles.ts` + `socketPaths.ts` — two parallel socket
  registries that must move together (#4195).
- `src/server/utilityTools.ts` setActiveDevice — treats "has sessionId but
  getSession null" as free-to-take; that's exactly the release-in-flight
  window.

No TODO/FIXME markers exist in lifecycle code — hazards live in prose
comments. **A refactor that drops a comment silently drops an invariant.**

## 7. Test discipline

- Unit tests: interface + fake + `FakeTimer`, <100ms, injected
  `IdGenerator`/`Random`; never resolve the real file-backed DB (guard in
  `src/db/database.ts`). No per-test retries — fix the seam, don't retry.
- Force the interleaving: races are tested by pausing at the injected seam
  (timer tick, deferred promise) and mutating state mid-flight. See
  `test/server/deviceTools.killDevice.test.ts` (same-ID replacement, late
  retirement, hung discovery) and `test/daemon/devicePool.test.ts` as the
  canonical patterns.
- Harness traps: match socket acks **by request id**, not first-ack;
  `FakeTimer` auto-fires scheduled intervals when advanced a full period
  (don't also fire manually); `initializeWithDevices` is deliberately a
  silent pre-populate (no ready listeners).
- **Known blind spot**: unit fakes can't represent live adb reconnect timing —
  #5369 shipped green through unit tests. Anything touching pool runtime
  identity (incarnation boundaries, name matching on real reconnects, the
  fast-restart case the pool cannot observe) needs a live-emulator check:
  `/manual-test` sweep, or
  `--cli startDevice`/`killDevice` against a real emulator; with ≥2
  emulators, sanity-check returned `deviceId` against `adb emu avd name`.
- Streaming changes (`deviceSessionUuid` stamping, subscription routing)
  are not exercised by standard device tools — they need a stream
  subscriber. A streaming-consumer smoke test is a known release-checklist
  gap; don't mark such changes verified off tool calls alone.
- Flake classification before re-run: macOS Node-TS contention (#5248)
  shows as either exit 124 (12-min suite ceiling) or one sub-100ms test
  blowing its budget; classify via cross-OS comparison + job log.
  `Publish Android Libraries Snapshot` reddens every merge and is
  non-blocking.

## 8. Key files

Tool surface: `src/server/deviceTools.ts` (startDevice/killDevice
choreography), `toolRegistry.ts` (resolution + autolock),
`ToolExecutionContext.ts`, `SessionToolBinding.ts`, `executionTracker.ts`,
`sessionReleaseBroadcast.ts`.
Daemon: `daemon.ts`, `manager.ts`, `DaemonLauncher.ts`, `daemonMcpProxy.ts`,
`socketServer.ts`, `daemonRequestHandlers.ts`, `constants.ts`,
`daemonState.ts`.
State: `devicePool.ts`, `sessionManager.ts`, `deviceSessionRegistry.ts`,
`deviceSessionResolver.ts`, `SessionHeartbeatMonitor.ts`,
`SingleFlightInterval.ts`, `poolConfig.ts`,
`src/db/deviceSessionRepository.ts`.
Boot/readiness: `src/utils/deviceBootService.ts`, `deviceUtils.ts`,
`AndroidEmulatorClient.ts`, `SimCtlClient.ts`, `deviceTimeouts.ts`,
`RunnerReadinessService.ts`, `deviceBootRecovery.ts`.
Shutdown: `src/processLifecycle.ts`, `shutdownCleanup.ts`,
`src/daemon/childProcessCleanup.ts`.

History catalog with every issue/PR by era and bug class:
`references/history.md`. Open threads: epic #5256 items (#5260 push-socket
auth, #5262 DaemonStreamHub, #5263 workspace keying), #4680/#4881 picker
boot flow, #4858 daemon status probe, #5415 concurrent screenshot collision.
