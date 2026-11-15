# Session state record

How the daemon tracks one session UUID's lifecycle and its durable `device_sessions` row.
`SessionSlots` (`src/daemon/sessionSlots.ts`) holds one explicit state record per UUID;
`SessionRowWriter` (`src/daemon/sessionRowWriter.ts`) sits beside it and owns row retries and
drain. Function names refer to `src/daemon/sessionManager.ts` and `src/daemon/sessionManager/`
unless a path says otherwise.

The row writer is on its own page:

- [5. Where SessionRowWriter sits; 6. Row writer implementation](session-state-record-row-writer.md)

## 1. Summary

- `SessionSlots` holds one `SessionSlot` per UUID, a discriminated union with explicit transitions
  that assert the from-state. It does no I/O and has no durable-row logic.
- Slots emit "desired row" intents and read only `rowPending`; the writer never reads slots.
- Activity writes stay direct and are guarded in SQL.
- A terminal release frees its device before its row lands only when its journal intent is
  durable; otherwise the row is written first, bounded by a deadline.

## 2. Terminal release durability

`FileTerminalReleaseJournal` (`src/daemon/terminalReleaseJournal.ts`) keeps one append-only JSONL
file per daemon in `<dataDir>/terminal-release-intents/`. Its `appendDurable` method is write plus
`fsyncSync`, run before the daemon issues the DB write. The first create fsyncs the parent directory;
compaction writes a sibling, fsyncs, renames and fsyncs the directory. On win32 the journal skips
directory fsyncs. The `record()` method returns `"durable"` or `"volatile"`. The default
`NoopTerminalReleaseJournal` (only `Daemon.startOn` attaches the file journal) and a failed append
return `volatile`, which is also the answer where the directory fsync is skipped. Replay ignores a
torn final line and discards a corrupt mid-file line with a warning.

- Crash after the intent, before the row: the next start applies it
  (`applyRecoveredTerminalReleaseIntents`, first in `rehydratePersistedSessions`). A dead peer's
  file is adopted at startup or when found dead later (`readDeadDaemon`,
  `fenceDeadDaemonIntents`).
- A missing intent after a crash leaves a stale `active` row with no reason;
  `markStaleActiveSessionsExpired` expires it to `daemon-restart`, making it recoverable, and
  rehydration reserves its device by stable id. Journal replay runs before that sweep.
- Shutdown: `drainReleasePromises` awaits releases, parked late writes and one retry round before
  the DB closes; a timed-out drain keeps the DB open and the intent on disk.

Release ordering:

- **Durable intent.** `fenceTerminalRelease` fences and records the intent synchronously, the final
  supersede fence runs, the removal commits, and only then is the row written
  (`persistCommittedTerminalRelease`). The device is freed (`notifySessionRelease`) without waiting
  for the row; the release still awaits the row afterwards, bounded by
  `SESSION_RELEASE_PERSIST_TIMEOUT_MS` (`SESSION_RELEASE_DRAIN_TIMEOUT_MS` 5 s + 1 s = 6 s; not the
  10 s `SESSION_RELEASE_TEARDOWN_CAP_MS`). A final fence that declines lifts the fence and resolves
  the intent in one turn. A row write that fails after the commit cannot keep the session: the
  device is already freed, the retry is scheduled (`scheduleTerminalReleaseRetry`), and the release
  rejects with the write error.
- **Volatile intent.** The row is written first, bounded by the same deadline; at the deadline the
  device is freed anyway.
- **No late supersede.** No supersede fence is evaluated once a row statement is issued, for any
  intent: a release whose row statement was issued has won. A durable release can still decline at
  the one fence before its row exists. A finishing live-row rewrite restores a terminal fence's row
  only for a volatile release (row written first) or one that has committed.
- **Non-terminal** releases write the row after the commit (`completeReleasePersistence`) and
  retry through the writer's non-terminal snapshots. A forced stuck release (`forceStuckRelease`)
  frees the device first and persists later (`persistForcedReleaseFence`).

Invariants that make freeing before the row safe:

- Device allocation does not read `device_sessions`: `getSessionForDevice` and
  `getHeldDeviceSessions` read only `deviceSessionMap`; `devicePool.ts` calls the repository only
  for `markAutolockSession`. A stale row cannot double-assign.
- The in-memory fence is raised before the write and never depends on it.
- `markStaleActiveSessionsExpired` spares a live peer's active rows, and `claimRecoverableSession`
  requires a non-active row with a re-issuable reason.
- The commit sequence (final fence, `journal.record`, `desire`, slot transition, device free) is
  synchronous, with no `await`.

Row guards live in SQL (`src/db/deviceSessionRepository.ts`): `expectedRowGeneration`,
`unlessTerminal`, `unlessTerminalOrOwnedByLivePeer`, and `activity_seq`. An activity write
overwrites activity columns only if its session-clock sequence is not older, and `recordActivity`
matches only `status = active`, so activity writes are commutative and cannot revive a terminal row.
Every `DeviceSessionPersistence` method is required, with one complete fake
(`test/fakes/FakeDeviceSessionPersistence.ts`).

## 3. Per-UUID record

```ts
type SlotTag = "assigning" | "creating" | "live" | "rebinding" | "releasing" | "ended" | "fenced";

type SessionSlotState =
  | {
      tag: "assigning";
      assignment: Promise<Session>;
      shared?: SharedSessionAssignment;
      releaseRequested?: PendingSessionRelease;
    }
  | {
      tag: "creating";
      creation: PendingSessionCreation;
      recovery?: DeviceSession;
      releaseRequested?: PendingSessionRelease;
    }
  | { tag: "live"; session: Session }
  | { tag: "rebinding"; session: Session; rebind: PendingSessionRebind }
  | {
      tag: "releasing";
      session: Session;
      op: SessionReleaseOperation;
      fence: "none" | "terminal";
      rebind?: PendingSessionRebind;
    }
  | {
      tag: "ended";
      identity: WeakRef<Session>;
      snapshot: SessionReleaseSnapshot;
      reason: ReleaseReasonState;
      source: "release" | "forced";
    } // non-terminal reason
  | {
      tag: "fenced";
      identity?: WeakRef<Session>;
      snapshot: SessionReleaseSnapshot;
      reason: ReleaseReasonState;
      reservation?: TerminalReleaseReservation;
      source: "release" | "forced" | "journal" | "peer-journal";
    };

interface SessionSlot {
  readonly uuid: string;
  state: SessionSlotState;
  /** Older incarnations whose release has committed but is still finalizing. */
  retiring: ReadonlySet<SessionReleaseOperation>;
  /** Resolves when the slot next changes tag; replaces the microtask-yield loops. */
  settled: Promise<void>;
}
```

Rules:

- Incarnation identity stays "the `Session` object in the record" (`state.session`,
  or `identity.deref()` after the session is gone). `Session` is unchanged.
- Per-incarnation history stays in identity-keyed side tables
  (`finalizedSessionReleases`, per-`Session` row-facet maps). They are not lifecycle, and they
  must outlive the slot being reoccupied (`ended` -> `creating`). Both
  `releaseFinalizedSession` and `releaseThatEnded` read an older incarnation's
  `ReleaseReasonState` while a newer one is live. Only the UUID-keyed latest-identity
  lookup moves into the slot.
- The row is not a field of the slot; `rowPending` reads through to the writer (§5).
- `ended` records are weak and evicted by the `FinalizationRegistry`. A `fenced`
  record is not GC-evicted: a terminal fence is permanent until lifted (inherited
  unbounded growth, out of scope).
- `deviceSessionMap` stays beside the store, maintained by the same transitions.

### 3.1 Legal transitions

Each is a `SessionSlots` method asserting the from-state. An illegal transition
throws in tests and warns+counts in production.

| From                          | To                                      | Cause                                                                                                                                            |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| absent                        | `assigning`                             | automatic device assignment starts                                                                                                               |
| absent                        | `creating`                              | `createSession`                                                                                                                                  |
| absent                        | `fenced`                                | startup/peer journal intent; refused creation or expired persisted row terminalized at admission (`terminalizeExpiredPersistedSession`)          |
| `assigning`                   | `creating`                              | device chosen, creation write starts                                                                                                             |
| `assigning` / `creating`      | absent                                  | assignment/creation failed or abandoned                                                                                                          |
| `creating`                    | `live` or `releasing`                   | publish; a recorded `releaseRequested` starts the release at once                                                                                |
| `ended`                       | `creating`                              | non-terminal release followed by recovery or revival                                                                                             |
| `fenced`                      | `creating`                              | only via a lift: reservation owner (`rebindSessionForTerminalReleaseRecovery`), plan-label mint                                                  |
| `live`                        | `rebinding`                             | `rebindSession`                                                                                                                                  |
| `rebinding`                   | `live`                                  | rebind published or rejected                                                                                                                     |
| `live`                        | `releasing`                             | `releaseSessionAttempt`                                                                                                                          |
| `rebinding`                   | `releasing`                             | release started during a rebind waits in stage `awaiting-rebind`; the rebind promise moves to `releasing.rebind`; a forced release does not wait |
| `releasing`                   | `ended`                                 | non-terminal commit                                                                                                                              |
| `releasing`                   | `fenced`                                | terminal commit                                                                                                                                  |
| `releasing`                   | `ended`/`fenced`, `source: "forced"`    | `forceStuckRelease` while the op is still in teardown: op moves to `retiring` and later returns null                                             |
| `releasing` (`fence: "none"`) | same, `fence: "terminal"`               | a terminal release upgrades the shared reason; the only legal mutation without a tag change                                                      |
| `ended`                       | absent                                  | session GC'd and nothing waits on the slot                                                                                                       |
| `releasing`                   | `live`                                  | supersede declined (`commitDeclined`); terminal fence lifted                                                                                     |
| `releasing`                   | `retiring` entry on the next slot state | commit while finalizing                                                                                                                          |

Unreachable: `rebinding` -> `ended`, `fenced` -> `live`, `ended` -> `fenced` (a
terminal upgrade happens while `releasing`). `commitReleaseRemoval` returning false is
unreachable under the slot design (the from-state assertion replaces it).

Only a recovery rebind (`RebindSessionOptions.recovery`: Android AVD recovery or System UI
replacement, i.e. an explicit bind carrying `expectedExistingSessionDeviceId`, and the terminal-release
recovery) counts. A client-chosen move (`setActiveDevice`, an explicit bind without that expectation)
and the undo of a cancelled one change the serial but neither bump the generation nor notify (#15456).
When the cause is unclear, the conservative reading treats the rebind as a move.

A serial-changing recovery rebind increments `Session.deviceGeneration` (absent
means zero) and records `previousDeviceId`, the serial before the latest recovery. It preserves the
session UUID and stable AVD/UDID identity. A later client-chosen move keeps both fields unchanged, so
they describe the last recovery, not the current move. These two fields are in-memory only, have no DB
schema or migration, and reset on daemon restart/rehydration. Same-serial rebinds,
including forced ones, preserve them. `sessionDeviceBinding` defines the shared
client shape; session-info and active-sessions use its diagnostic field names.

After persistence and live binding/index publication, SessionManager emits once
per serial-changing recovery rebind through an injected emitter. The process broadcaster
feeds only the notification-subscribed sockets that hold the session. A socket holds it when it
acquired or restored it, holds its autolock route, or last routed a call to it; a derived
`base:label` is held through its base. Proxies then filter again to held sessions,
and the MCP server forwards `session_device_rebound` as an info logging message.
Fan-out failures warn without failing recovery. Admitted daemon tool results add
`_meta["automobile/sessionDevice"]` only after generation zero; steady-state
results are unchanged, and the proxy preserves result metadata. Device-loss
shaping independently reads the live session on every incident-resolution path,
adding replacement/retry evidence without replacing an incident's recovery status.

Rebind during release: `rebindSession` awaits an in-flight release then throws
unconditionally, even if the release was declined and the session is `live` again.

## 4. Predicates and guard findings

Predicate mappings:

- `isCurrentSession(s)`: `slot.session === s` and tag in {`live`, `rebinding`}, or
  `releasing` with `fence: "none"`.
- `isAdmittedForAutomation(s)`: current identity with no terminal fence and not
  releasing (not tag-only; see finding 4 below).
- `isLatestSessionIdentity(s)`: slot identity equals `s` (`creating`/`assigning` false).
- `isSessionBeingRecreated(u)`: tag in {`assigning`, `creating`, `live`, `rebinding`,
  `releasing`}.
- `getAllKnownSessionIds()`: ordinary occupied tags plus any `residue`-flagged record
  (including `absent`, `ended`, `fenced`).
- `getHeldDeviceSessions()`: device index joined with the slot's `session`.

`SessionSlots.settled(uuid, view)` is resolve-only and all three `waitOut*Of`
implementations remain: characterization showed switching changes timing.

### S2 agreement findings

Design-visible resolutions from the shadow-only agreement harness
(`getLegacyLifecycleView()` borrows the real maps read-only; ten one-statement hooks
observe creation/assignment start/end, publication, rebind start/end, release
start/end, unpublication). Diagnostics default to `log` (debug; derivation exceptions
caught and warned) and `throw` in tests; no diagnostic controls a lifecycle decision
in production. The test-local oracle is a frozen copy of the old predicates.

1. **Published releases are still being recreated**: `releasing` joins the recreation
   tag set (the WeakSet add precedes release-op installation, so that window derives
   `releasing` too).
2. **A declined commit does not override a terminal fence**: any published session
   with a held terminal snapshot derives `releasing` with `fence: "terminal"`,
   including declined operations (current/admission false; known/recreated true). A
   real failed terminal write also leaves a published session and fence with **no
   release operation**, even after settling, so the `releasing` tag cannot require an
   op payload. A newly raised fence can be lifted during a declined release's
   live-row rewrite; `releasing -> live` stays legal.
3. **Orphan bookkeeping is known residue**: `DerivedSlot.residue: true` retains
   membership for `pendingSessionReleases`, `pendingSessionRebinds` or
   `releasePromises` after publication/creation/assignment are gone (may decorate
   `absent`, `ended`, `fenced`). A forced release during a parked rebind reproduces an
   orphan rebind. They clear when outstanding work settles but a parked await can
   retain them indefinitely; known-id reads must keep them until continuations clean
   up (or prove equivalent atomic cleanup), never silently drop them as absent.
4. **Admission is not tag-only**: release ops outlive removal and can outlive WeakSet
   cleanup on a published incarnation. A non-terminal `releasing` tag can therefore be
   current and admitted after that cleanup, while a terminal-fenced published session
   stays blocked even without WeakSet membership. Mapping: current-by-tag/fence, then
   `!view.isReleasing(publishedSession)`. Superseded/stale ops never replace a newer
   published identity.
5. **Known and latest identity have separate precedence**: an unpublished release op
   stays known even when tag is `ended`/`fenced` (residue). Latest identity picks
   published, then rejects pending creation/assignment, then release-op identity, then
   the weak finalized identity. `getHeldDeviceSessions` is outside S2 (device index
   join, not a UUID-only predicate).

Per-UUID known-id derivation stays constant-time. The test-local oracle checks the real
public union's order and membership after operations and microtask yields. It runs 29 seeds
including a pinned corpus, 36 random steps and three forced reincarnations in `beforeAll`.
It also covers a shutdown drain and rehydration of a recoverable row with the in-memory
persistence/journal, with no devices or SQLite.

### S7 guard findings

The tag guard observes the ten hooks synchronously; unchanged positions are no-ops. No
lifecycle behavior or transition table changed. Four coarse observations follow paths
already allowed by §3.1 (the intermediate tag is not seen by the hook); the guard logs
them at debug and counts them:

| Hook           | Observed pair         | Legal path / evidence                                                                                             |
| -------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| published      | absent -> live        | absent -> creating -> live; already-published shadow-probe fixture                                                |
| assignment-end | assigning -> fenced   | assigning -> absent -> fenced; refused acquisition / admission fencing (`sessionManager.terminalRelease.test.ts`) |
| creation-end   | creating -> fenced    | creating -> absent -> fenced; cancelled client-chosen creation (`sessionManager.cancelledClientChosenId.test.ts`) |
| unpublished    | releasing -> creating | releasing -> ended -> creating; covering creation resurfaces (`sessionSlots.agreement.test.ts`)                   |

These pairs are not allowed by §3.1 and stay **debug+count even in test throw mode**,
scoped to the exact hook; other illegal pairs throw under test. They are findings, not
new legal transitions:

| Hook             | Observed pair          | Existing behavior / evidence                                                                                                                         |
| ---------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| assignment-start | ended -> assigning     | Revival first assigns a device (three forced reincarnations)                                                                                         |
| assignment-end   | assigning -> ended     | Failed assignment reveals an older finalized identity                                                                                                |
| creation-end     | creating -> assigning  | Creation clears before the covering assignment's finally                                                                                             |
| creation-end     | creating -> ended      | Failed creation reveals an older finalized identity                                                                                                  |
| unpublished      | releasing -> assigning | Removing the published incarnation reveals a covering assignment                                                                                     |
| release-end      | ended -> fenced        | Terminal upgrade of an already finalized non-terminal release (`sessionManager.terminalRelease.test.ts`, `deviceRestartRecoveryReservation.test.ts`) |
| release-end      | ended -> live          | `daemonShutdownSessionRelease.test.ts` injects a replacement into `sessions` bypassing publication; test-only                                        |

`sessionManager.waitOutSettled.test.ts` pins native microtask turns with FakeTimer
using controlled issuer continuations and real gated manager operations. With
`settled`, controlled release resumed at turn 3 (not 5) and rebind at turn 3 (not 2).
In real operations release resumed at turn 5 (not 13) and rebind at 24 (not 23).
Recreation wakes on publication, sees the creation still present, then cannot observe
another tag change when that facet clears, so it never finishes. Hence all three
original waits stay, including recreation's microtask yield.

## Background

- [Session state record and row writer design](../devlog/2026-10-15-session-state-record-design.md)
