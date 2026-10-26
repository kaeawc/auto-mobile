# Session state record

Design note for #11798 (one explicit state record per session UUID) and the two
"Not verified" questions of #11799 (one per-UUID row writer with deadline-bounded
serialization). `SessionSlots` (Part A, S1-S9) is implemented; the `SessionRowWriter`
migration (Part B) is partly implemented, see §6. Function names refer to
`src/daemon/sessionManager.ts` unless a path says otherwise; line numbers are
deliberately omitted because they rot.

## Summary

- A session UUID's lifecycle was the conjunction of membership in ~17 maps and sets
  plus flags on three records, read by six hand-written predicates each using a
  different subset.
- `SessionSlots` holds one `SessionSlot` per UUID, a discriminated union with
  explicit transitions that assert the from-state. No I/O and no durable-row logic.
- #11799's `SessionRowWriter` sits beside it, not inside it. Slots emit "desired row"
  intents; the writer owns every status-changing `device_sessions` write for the
  UUID; slots only read `rowPending`.
- Verdict 1: the journal is durable enough for terminal intents **only on the daemon
  path and only when its append succeeded**, so the writer must be told whether it
  did. Verdict 2: freeing the device before the terminal row lands is **acceptable
  only when the intent is durable**, and already is the norm for non-terminal
  releases and two terminal paths.

## 1. Current state (evidence)

### 1.1 Per-UUID lifecycle state (original inventory)

`U` = keyed by UUID, `S` = keyed by `Session` object identity (`WeakMap`/`WeakSet`).
Groups marked "now SessionSlots" have moved.

| Concern                | Fields                                                                                                                                              | Key         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Published              | `sessions`                                                                                                                                          | U           |
| Device index           | `deviceSessionMap` (stays beside the store)                                                                                                         | U / device  |
| Assignment             | `pendingSessionAssignments`, `sharedSessionAssignments` (now SessionSlots)                                                                          | U           |
| Creation               | `pendingSessionCreations`, `pendingPersistedRecoveries`, `claimedRecoverableRows` (now SessionSlots)                                                | U / S       |
| Rebind                 | `pendingSessionRebinds`, `deferredRebindCleanups` (now SessionSlots)                                                                                | U           |
| Release before publish | `pendingSessionReleases` (now SessionSlots)                                                                                                         | U           |
| Release in flight      | `releasePromises`, `activeReleasePromises`, `releasingSessions` (now SessionSlots)                                                                  | U / set / S |
| Terminal fence         | `terminalReleaseSnapshots`, `terminalReleaseReasonStates`, `terminalReleaseReservations` (now SessionSlots)                                         | U           |
| Finalized identity     | `finalizedSessionReleases` (stays an S-keyed side table), `latestFinalizedSessionIdentities`, `finalizedSessionIdentityRegistry` (now SessionSlots) | S / U       |
| Forced release         | `forcedNonTerminalReleases` (now SessionSlots)                                                                                                      | S           |
| Journal recovery       | `recoveredTerminalReleaseIntents`, `adoptedDeadDaemonJournals`, `adoptedTerminalReleaseOwners` (now SessionSlots)                                   | U / daemon  |
| Row facet (1.3)        | 17 fields                                                                                                                                           | U / S       |

Flags on records carry more lifecycle: `forced`, `commitFenced`, `commitDeclined`,
`stage` (`SessionReleaseOperation`) and `terminalPersisted`, `lateTerminalRelease`,
`finalizedSnapshot` (`ReleaseReasonState`).

Out of scope (UUID-keyed but not lifecycle): derived-label maps
(`derivedLabelSessionsByBase`, `endedLabelBases`, `planLabelMints`,
`runningPlanLabelSessions`), restore queues and mutation chains (`clock*`,
`rotation*`, `screenReader*`, `networkCondition*`), per-device cleanup bookkeeping.
Only `endedLabelBases` is touched by a transition.

### 1.2 Hand-written predicates (replaced by tag reads in S7)

| Predicate                 | Read                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `isCurrentSession`        | `sessions`, `terminalReleaseSnapshots`                                                                                    |
| `isAdmittedForAutomation` | the above + `releasingSessions`                                                                                           |
| `isLatestSessionIdentity` | `sessions`, `pendingSessionCreations`, `pendingSessionAssignments`, `releasePromises`, `latestFinalizedSessionIdentities` |
| `isSessionBeingRecreated` | `sessions`, `pendingSessionCreations`, `pendingSessionAssignments`                                                        |
| `getAllKnownSessionIds`   | six maps                                                                                                                  |
| `getHeldDeviceSessions`   | `deviceSessionMap`, `sessions`, `releasePromises`                                                                         |

"Releasing" was tracked three ways (by object, id, operation). `waitOutRecreationOf`
is a workaround for the scatter (yields because another continuation clears the
maps). `getSession` is not a query: `getSessionInternal` starts a release when it
finds an expired session (`releaseExpiredSessionLazily`); it had 31 in-class and ~84
external callers, versus the side-effect-free `peekSession`.

### 1.3 Durable row writes (the row facet)

| Write                       | Site                                                                       | Repository call                                       |
| --------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| Create / recovery claim     | `persistSession` via `persistAndPublishSession`                            | `upsertActiveSession`                                 |
| Rebind                      | `persistAndPublishRebind` -> `persistSession`                              | `upsertActiveSession`                                 |
| Superseded-row rewrite      | `reassertSupersededLiveRow`, `replaceSupersededReleaseRow`                 | `upsertActiveSession`                                 |
| Activity                    | `persistSessionActivity`                                                   | `recordActivity`                                      |
| Activity repair             | `rePersistSessionActivity`                                                 | `upsertActiveSession`                                 |
| Release (terminal and not)  | `persistSessionRelease`                                                    | `markReleased`                                        |
| Release retry               | `retryTerminalReleaseWrite`                                                | `markReleased`                                        |
| Startup / peer-dead intents | `applyRecoveredTerminalReleaseIntents`, `fenceDeadDaemonIntents`           | `markReleased`                                        |
| Expired persisted           | `terminalizeExpiredPersistedSession`, `tryReleaseUnrecoveredReissuableRow` | `markReleased`                                        |
| Liveness owner              | several sites                                                              | `recordLivenessOwnership`, `replaceLivenessOwnership` |

Guards live in SQL, not memory (`src/db/deviceSessionRepository.ts`):
`expectedRowGeneration`, `unlessTerminal`, `unlessTerminalOrOwnedByLivePeer`, and
(since #12463) `activity_seq`: an activity write overwrites activity columns only if
its session-clock sequence is not older, and `recordActivity` matches only
`status = active`. Activity writes are therefore commutative and cannot revive a
terminal row; they need no writer serialization, only a way to report "row not
active". #12465 made every `DeviceSessionPersistence` method required, so a writer
builds on one complete interface and one complete fake
(`test/fakes/FakeDeviceSessionPersistence.ts`).

The #11799 "patch-on-patch" chain: `supersededReleaseReasons`,
`pendingSupersededRowReasserts`, `supersededRowsUnderPendingRelease`,
`supersededReasonsBeingRewritten`, `owedSupersededRowReasserts`,
`releaseReasonPredecessors`, `refusedReleaseWrites`, their backoff, and two
same-shaped retry record types (`TerminalReleaseRetry`, `OwedSupersededRowReassert`).

### 1.4 Release ordering today (`releaseSessionInternal`)

1. Teardown, then the first supersede fence.
2. Terminal only: `persistTerminalReleaseWithinDeadline` raises the in-memory fence
   (`terminalReleaseSnapshots.set`), then `persistSessionRelease` records the journal
   intent **before** issuing `markReleased`, bounded by
   `SESSION_RELEASE_PERSIST_TIMEOUT_MS` = `SESSION_RELEASE_DRAIN_TIMEOUT_MS` (5 s) + 1 s
   = **6 s** (not the 10 s `SESSION_RELEASE_TEARDOWN_CAP_MS`, a different bound). At
   the deadline the device is freed anyway.
3. Final supersede fence, synchronous with the commit; a decline here forces
   `abandonReleaseSupersededAfterPersist` and the rewrite chain.
4. `commitReleaseRemoval` removes the session and frees the device.
5. Non-terminal only: the row is written **after** the commit
   (`completeReleasePersistence`), retried via `pendingNonTerminalReleaseSnapshots`
   (#11557).

A forced stuck release (`forceStuckRelease`) also frees the device first and persists
later (`persistForcedReleaseFence`).

## 2. The two #11799 questions

### Q1. Is the journal durable enough for "ended but row not yet written"?

**Verdict: not everywhere. Yes for terminal intents on the daemon path, provided the
append succeeded; the writer must be told whether it did.**

Holds (`src/daemon/terminalReleaseJournal.ts`):

- `FileTerminalReleaseJournal`: one append-only JSONL file per daemon in
  `<dataDir>/terminal-release-intents/`. `appendDurable` = write + `fsyncSync`, run
  before the DB write is issued. Compaction: write sibling, fsync, rename, fsync dir.
- Crash after intent, before row: next start applies it
  (`applyRecoveredTerminalReleaseIntents`, first in `rehydratePersistedSessions`). A
  dead peer's file is adopted at startup or when found dead later (`readDeadDaemon`,
  `fenceDeadDaemonIntents`, #11355).
- Shutdown: `drainReleasePromises` awaits releases, parked late writes and one
  retry round before the DB closes; a timed-out drain keeps the DB open and the
  intent on disk.
- Tests: `sessionManager.releasePersistDeadline.test.ts` (crash after the intent
  restarts the UUID terminal; torn tail ignored).

Gaps:

1. `record()` swallows an append failure (warn) and `persistSessionRelease` writes
   regardless: no crash safety and nothing says so; under free-before-row this is a
   revival window.
2. Default is `NoopTerminalReleaseJournal`; the only attach is in `Daemon.startOn`
   and the only `new SessionManager(` is in `daemon.ts`. Anything else (and every
   unit test not opting in) has no durability.
3. The first append to a new file does not fsync the parent directory (only
   compaction does).
4. A corrupt mid-file line drops that intent at debug level; only a torn final line
   is handled deliberately.
5. If compaction and the lift-marker append both fail, a stale intent can terminalize
   a live session on restart.
6. Terminal intents only. A non-terminal "ended, row not written" (device restart)
   lives in `pendingNonTerminalReleaseSnapshots`; a crash leaves the row active and
   rehydration recovers it, which is intended.

A missing intent after a crash leaves a stale `active` row with no reason;
`markStaleActiveSessionsExpired` (`daemon.ts`) expires it to `daemon-restart`, making
it recoverable, and rehydration reserves its device by stable id. The failure is a
revived UUID and a phantom hold on a device possibly owned by another session.
Journal replay runs before the listing; that ordering was read, not run, and is
checked in W1.

Required: `record()` returns `"durable" | "volatile"`; Noop returns `"volatile"`;
fsync the directory on first create; warn on a corrupt mid-file line (W1,
journal-only).

### Q2. Is freeing the device before the terminal row lands acceptable?

**Verdict: acceptable when the intent is durable. It already happens on three paths;
the proposal makes it the single path for terminal releases and adds the missing
condition.**

Already happens: the terminal deadline path (device freed after 6 s with the row
unwritten; the in-memory fence keeps the UUID from routing;
`sessionManager.releasePersistDeadline.test.ts` asserts held 1 ms before the
deadline, freed at it, snapshot kept); `forceStuckRelease`; every non-terminal
release.

Why safe:

- Device allocation does not read `device_sessions`: `getSessionForDevice` and
  `getHeldDeviceSessions` read only `deviceSessionMap`; `devicePool.ts` calls the
  repository only for `markAutolockSession`. A stale row cannot double-assign.
- The in-memory fence is raised before the write and never depends on it.
- Peers: `markStaleActiveSessionsExpired` spares a live peer's active rows and
  `claimRecoverableSession` requires a non-active row with a re-issuable reason.

Risks and bounds:

1. Crash between free and row landing: covered only if the intent is durable. Rule:
   **free before the row only when `journal.record` returned `durable`; otherwise
   write first, bounded by the existing deadline, as today.** On Noop and after a
   failed append the order is unchanged (direct mode and unit tests see no change).
2. Ghost `active` row between free and landing. Readers: startup rehydration,
   UUID-only recovery (`readPersistedSession`), admission (`createUnseenSession`
   treats only a terminal row as blocking), video-recording reclaim (operational
   phantom hold only), appearance sweep (cosmetic). In a live process the in-memory
   fence decides.
3. **Existing gap to close: a terminal write carries no generation.**
   `releaseWritePrecondition` sets `expectedRowGeneration` only for non-terminal and
   `daemon-shutdown` releases, and `livePeerDaemonSessionIds` is hard-coded empty. A
   parked terminal write can land on a row the same daemon re-upserted for the same
   UUID after the fence was lifted; only the in-memory fence prevents it. No test
   reproduces it. W2 owner decision: a write frees its slot at its deadline; the SQL
   generation guard, not in-process serialization, closes the late-overwrite gap.
   Before the deadline a later desire waits for the issued write; after it, a later
   write may issue while the parked statement stays tracked for callbacks and drain.
   Whether production `markReleased` can interleave at all (bun:sqlite is
   synchronous) is confirmed in W2; if not, the gap exists only on retry/park paths.
4. Wedged writer: one coalesced intent per UUID; physically unsettled parked writes
   tracked separately; a deadline-expired write no longer occupies the issuing slot
   (at most one unexpired write at a time).
5. Part two of #11799 removes the superseded-after-persist path: after a
   free-before-row commit a later supersede is refused (release already won) rather
   than rewritten. Sound only because final fence, journal append and commit are
   synchronous (no `await` between).

A fault-injection test (W2) makes this checkable: fail the journal append, the row
write and the process at each await and assert the post-restart row equals the
in-memory outcome.

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
  (`finalizedSessionReleases`, per-`Session` row-facet maps): not lifecycle, and they
  must outlive the slot being reoccupied (`ended` -> `creating`) because
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

Rebind during release: `rebindSession` awaits an in-flight release then throws
unconditionally, even if the release was declined and the session is `live` again.
The slot design would replace that with `await slot.settled` and re-dispatch on the new
tag, the one place that could change behaviour, so it needs its own test and PR note.

## 4. Mapping of existing state

| Existing                                                                                                                                                                                                                                                                                                                     | New home                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`                                                                                                                                                                                                                                                                                                                   | `state.session` of `live` / `rebinding` / `releasing`                                                                               |
| `pendingSessionAssignments`, `sharedSessionAssignments`                                                                                                                                                                                                                                                                      | `assigning`                                                                                                                         |
| `pendingSessionCreations`, `pendingPersistedRecoveries`, `claimedRecoverableRows`                                                                                                                                                                                                                                            | `creating.creation`, `creating.recovery`                                                                                            |
| `pendingSessionReleases`                                                                                                                                                                                                                                                                                                     | `releaseRequested` on `assigning` / `creating`                                                                                      |
| `pendingSessionRebinds`, `deferredRebindCleanups`                                                                                                                                                                                                                                                                            | `rebinding.rebind` or `releasing.rebind` (cleanups a per-slot list)                                                                 |
| `releasePromises`, `releasingSessions`, `forced`, `commitFenced`, `stage`                                                                                                                                                                                                                                                    | `releasing.op` (`releasingSessions` is `tag === "releasing"`)                                                                       |
| `activeReleasePromises`                                                                                                                                                                                                                                                                                                      | `releasing.op` plus `retiring` (derived set across slots)                                                                           |
| `terminalReleaseSnapshots`, `terminalReleaseReasonStates`                                                                                                                                                                                                                                                                    | `fenced.snapshot` / `fenced.reason`; `releasing.fence`                                                                              |
| `terminalReleaseReservations`                                                                                                                                                                                                                                                                                                | `fenced.reservation`                                                                                                                |
| `latestFinalizedSessionIdentities`, registry                                                                                                                                                                                                                                                                                 | `ended.identity` / `fenced.identity`                                                                                                |
| `finalizedSessionReleases` (S-keyed)                                                                                                                                                                                                                                                                                         | stays an identity-keyed side table                                                                                                  |
| `recoveredTerminalReleaseIntents`, `adoptedTerminalReleaseOwners`, `adoptedDeadDaemonJournals`                                                                                                                                                                                                                               | `fenced` with `source: "journal"` / `"peer-journal"` (adopting owner stays on the snapshot); the dead-daemon set stays daemon-level |
| `forcedNonTerminalReleases`                                                                                                                                                                                                                                                                                                  | `ended.source = "forced"` plus snapshot; the stuck op lives on in `retiring`                                                        |
| Row facet (`pendingTerminalReleaseRetries`, `lateReleaseWrites`, `releaseDrainStarted`, `pendingNonTerminalReleaseSnapshots`, the superseded-row fields, `refusedReleaseWrites`, `releaseRowGenerations`, `persistedRowGenerations`, `issuedActivityWrites`, `retiredCreationRows`, `activityRowRePersists`, retry backoffs) | `SessionRowWriter` (#11799); #11798 does not move them                                                                              |

Predicate mappings:

- `isCurrentSession(s)`: `slot.session === s` and tag in {`live`, `rebinding`}, or
  `releasing` with `fence: "none"`.
- `isAdmittedForAutomation(s)`: current identity with no terminal fence and not
  releasing (see finding 4 below; not tag-only).
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
   cleanup on a published incarnation, so a non-terminal `releasing` tag can be
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
public union's order and membership after operations and microtask yields (29 seeds
including a pinned corpus, 36 random steps, three forced reincarnations in `beforeAll`;
also a shutdown drain and rehydration of a recoverable row with the in-memory
persistence/journal; no devices or SQLite).

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
`settled`, controlled release resumed at turn 3 (not 5) and rebind at turn 3 (not 2);
in real operations release resumed at turn 5 (not 13) and rebind at 24 (not 23);
recreation wakes on publication, sees the creation still present, then cannot observe
another tag change when that facet clears, so it never finishes. Hence all three
original waits stay, including recreation's microtask yield.

## 5. Where `SessionRowWriter` sits

```
SessionManager
 |-- SessionSlots (sync, pure, no I/O)        -- tag, session, op, fence, retiring
 |       | emits desired-row intents on transitions
 |       v
 |-- SessionRowWriter (async I/O, per-UUID)  -- desired row, one unexpired write, one backoff
 |       |-- DeviceSessionPersistence (#12465 interface)
 |       `-- TerminalReleaseJournal           -- record() before a terminal intent is queued
 `-- activity writes: direct `recordActivity` (commutative via activity_seq)
```

- Direction is slots -> writer; the writer never reads slots. The supersede decision
  is made by the transition (the intent is replaced before it is written); an already
  issued parked statement still needs its SQL generation guard.
- API: `desire(uuid, DesiredRow)`, `pending(uuid): boolean` (read by slots as
  `rowPending`), `settled(uuid)`, `drain()` (shutdown, where `drainReleasePromises`
  is today).
- A `DesiredRow` is a full row image, so replacing an unwritten desire is sound:
  `live(binding, activity) | released(reason, binding) | terminal(reason, binding,
journaled)`. `released`/`terminal` carry the binding because `markReleased` is an
  UPDATE: if the row does not exist yet, the writer upserts with the release status.
  Replacement applies to an **unwritten** desire only; an issued write occupies the
  slot until it settles or hits its deadline (per the W2 owner decision, then the next
  same-UUID write may issue while the old statement is parked, still tracked for
  late/refused callbacks, `settled` and `drain`). A terminal desire is never replaced
  by a non-terminal one unless the slot was lifted (`fenced` -> `creating`).
- Writer invariant: **an intent on disk implies the slot is `fenced`** (or `releasing`
  with `fence: "terminal"`). Startup replay has no generation guard, only "the row's
  reason is not terminal", so every path that replaces or refuses a durable terminal
  intent must call `journal.resolve` synchronously with the transition: the `fenced`
  -> `creating` lift, a superseded fence, a terminal write the generation guard
  refuses. Otherwise a restart would terminalize a newer incarnation of the same UUID.
- Cross-daemon safety keeps `expectedRowGeneration` and `unlessTerminal*` in SQL. The
  writer adds a generation guard to terminal writes (Q2 risk 3), named as a guard change
  in W2. Before classifying a generation advance as foreign, the release path awaits
  that incarnation's in-flight own row writes after reading the row (#12547), bounded
  by the persistence deadline; other incarnations stay protected by the guard.
- Terminal ordering (Q2): `desire(terminal)` is called synchronously after the final
  fence and after `journal.record` returned `durable`; the commit then frees the
  device. On `volatile` the release awaits the write first, bounded as today.
- Activity: `recordActivity` stays direct. On `DeviceSessionNotActiveError` it reports
  `rowLost(uuid)` to the slots, which re-emit `desire(live)` only when the tag is
  `live` or `rebinding`; the `unlessReleased` SQL guard stays. This keeps the direction
  slots -> writer and prevents revival when the row is inactive because a terminal
  release landed.
- The commit sequence (final fence, `journal.record`, `desire`, slot transition, device
  free) is one synchronous method with no `await`, so the ordering stops being a
  comment.

## 6. Staged migration

Principles: introduce in parallel, assert agreement, switch reads, delete maps one
group per PR. Every PR is behaviour-preserving, adds no public API, keeps unit tests
under 100 ms (FakeTimer, `FakeDeviceSessionPersistence`,
`FakeTerminalReleaseJournalFileSystem`). #11784 (per-file line-count ratchet) lands
first so extracted modules cannot grow back. New code goes in `SessionSlots` /
`SessionRowWriter` so `sessionManager.ts` shrinks monotonically.

### Part A: #11798 (all landed)

| #   | Step                                                                                                                                                                                                                                                                                   | Status / notes             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| S1  | Types, transition table, pure `deriveSlotTag(legacyView)`                                                                                                                                                                                                                              | landed                     |
| S2  | Shadow probe `lifecycleTagOf(uuid)` plus seeded random-interleaving agreement test under FakeTimer                                                                                                                                                                                     | landed (§4 findings)       |
| S3  | Assignment and creation group in `SessionSlots`                                                                                                                                                                                                                                        | landed                     |
| S4  | Rebind group                                                                                                                                                                                                                                                                           | landed                     |
| S5  | Release group (`releasing.op`, `retiring`); highest risk                                                                                                                                                                                                                               | landed                     |
| S6  | Fence and identity group; `finalizedSessionReleases` stays a side table; GC test through a fake `FinalizationRegistry` seam                                                                                                                                                            | landed                     |
| S7  | Predicates become tag reads; `settled` lands but all three `waitOut*Of` stay; illegal transitions throw in test, warn+count in production                                                                                                                                              | landed                     |
| S8  | `findSession` is the pure lookup; `expireIfDue` keeps lazy expiry at retained admission/routing sites (#12581); retained readers are listed in `test/lint/findSessionNoRelease.test.ts`; external `getSession` callers migrate by directory (`RETAINED_SERVER_EXPIRY_READERS` ratchet) | landed, tracked separately |
| S9  | Slot code reads no row-facet field; `rowPending(uuid)` is the only row signal, wired to `SessionRowWriter.pending` in W2                                                                                                                                                               | landed, closes #11798      |

### Part B: #11799

Implemented: SessionRowWriter owns the drain-write set (formerly `lateReleaseWrites`),
terminal retry scheduling and the non-terminal snapshot map (adapter surface:
`noteRelease`, `noteLive`, `canIssueRelease`, `scheduleRetry`; in production
`pending(uuid)` means only "retry owed"). W3 moved create/rebind upserts, activity and
ownership statements behind `upsertLive`, `recordLiveActivity`,
`replaceLiveOwnership` (pass-through, same await sequence), and moved the
superseded-row state into `SessionRowWriter.superseded`
(`src/daemon/supersededRowReasserts.ts`: remembered superseded reasons, release-reason
predecessors, refused release writes, pending-rewrite counts, rows under pending
non-terminal releases, owed rewrites with backoff/timers/drain attempt, keyed off the
writer's drain flag). Row policy stays with the manager as per-entry callbacks
(`retry`, `retryDuringDrain`) so every read, statement and await keeps its order; the
rewrite chain is deleted in W5.

The per-UUID desire/settled/drain engine in `sessionRowWriter.ts` is test-exercised;
production first-attempt writes do not use it yet and stay manager-side until W3/W4
finish. The past-deadline-frees-the-slot decision is implemented in that engine.
Production still has no per-UUID serialization.

Behavior-preserving adapter: first-attempt persistence, deadline/fallback and late
callbacks stay on the manager; the writer owns retry scheduling and drain tracking. At
synchronous issue a still-current terminal snapshot remains writable; otherwise first
and retried statements consult the writer's snapshot desire sequence. Publish and
rebind publish call `noteLive` synchronously; the current terminal fence takes
precedence over a rebind live sequence. A sequence refusal after a lift is a named
subtype of `DeviceSessionRowNotReleasableError` and follows
`handleReleaseWriteFailure` -> `confirmReleaseWrite`, resolving the journal without
SQL-miss reclassification. Forced snapshots capture the session's known SQL generation
and weak incarnation identity for the same-session rebind classifier. Real statement
refusals keep their read/classify/retry sequence; no new manager awaits or promise
hops.

| Path                                                            | Terminal guard form                                                                                                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persistSessionRelease` (incl. forced fence, creation rollback) | Current terminal fence, else snapshot desire/live sequence at the synchronous issue boundary; captured `expectedRowGeneration` plus `unlessTerminalOrOwnedByLivePeer` at SQL when known |
| Writer-scheduled manager retry                                  | Same current-fence/desire/live check, cancellation identity, fresh `retriedReleaseWritePrecondition` read; SQL generation whenever known                                                |
| Refused-row fallback / physically parked statement              | Same sequence check before a further statement issues; issued SQL keeps its original generation guard; same-incarnation SQL classification and W3/W5 compensation remain                |
| No captured generation and no newer in-process live generation  | Existing `unlessTerminalOrOwnedByLivePeer` only; no invented generation                                                                                                                 |
| Standalone writer desires / retries                             | Monotonic desire/live sequence checked after async preconditions and immediately before every issue; supplied SQL generation forwarded unchanged                                        |
| Startup replay / peer adoption                                  | Existing statement ownership/terminal guards; replay precedes live publication; resolution routes through `liftTerminalFence`                                                           |

`liftTerminalFence` performs deletion, volatile-intent clearing, journal resolution and
writer cancellation in one synchronous turn. Successful writes, refusals,
rejected-creation fence adoption and startup replay keep the terminal admission fence
(resolving an intent must not make an ended UUID reusable) and cancel only the matching
snapshot without eagerly removing the manager retry entry. Actual lifts remove the
snapshot and cancel terminal desires and scheduled retries together. Plan-label minting
keeps its shadow probe and reason-state deletion between snapshot deletion and journal
resolution; startup keeps recovered-intent/probe/adopted-owner deletion before
resolution; retry-drop keeps cancel-retry and superseded bookkeeping before resolution.
A durable `record` clearing the volatile signal is not a fence lift. Two behavior
changes: a non-terminal commit now also deletes the volatile intent, resolves the
journal and cancels a terminal retry (skipped when no terminal snapshot is fenced); and
forced terminal snapshots now capture `expectedRowGeneration` and `releaseRowSessions`.

At most one unexpired standalone desire per UUID may issue; parked statements stay
tracked for callbacks and drain. Production bun:sqlite is synchronous, so the
overwrite regression parks injected statements and retry/precondition work around the
actual manager lift/publication. Fault tests use in-memory persistence and journal
files only. The synchronous journal fake models hang/delay as a whole-process pause
(an injected supervisor advances FakeTimer without firing JS callbacks; an in-process
rebind cannot run inside it); rejected journal syscalls yield the W1 volatile result;
persistence hang/delay suspends across FakeTimer turns; crash cases discard the manager
and replay the committed disk prefix via `rehydratePersistedSessions`.

| #   | Step                                                                                                                                                                                                                                                                                     | Size | Test plan                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Journal hardening, independent: `record()` returns `durable`/`volatile`; directory fsync on first create (skipped on win32 like compaction); warn on mid-file corruption; Noop returns `volatile`; verify and pin restart ordering of `markStaleActiveSessionsExpired` vs journal replay | S    | Journal unit tests with `FakeTerminalReleaseJournalFileSystem`: failed append gives `volatile`, crash simulation, torn and mid-file corruption; restart-ordering test including the `deadlineAt` break case where unapplied intents meet the stale-active sweep |
| W2  | `SessionRowWriter` for release rows only; replaces `pendingTerminalReleaseRetries`, `lateReleaseWrites`, `pendingNonTerminalReleaseSnapshots`; same ordering (terminal row before commit); adds the terminal generation guard (Q2 risk 3), named in the PR title                         | L    | `releaseRowRetry`, `releasePersistDeadline`, `rowInvariant` unchanged; fault injection failing each write kind at each await; regression test for same-UUID overwrite                                                                                           |
| W3  | Create / rebind / activity-repair writes move to the writer; superseded-row fields and `OwedSupersededRowReassert` deleted                                                                                                                                                               | L    | `supersededRowReassertRetry`, `rowWritesRemainingCases`; fault injection extended                                                                                                                                                                               |
| W4  | Behaviour change, isolated: terminal write after the final fence when `journal.record` is `durable` (§5); the only PR that changes ordering                                                                                                                                              | M    | Crash after free; record failure falls back to write-first; supersede after commit is refused; Linux and macOS CI                                                                                                                                               |
| W5  | Delete `abandonReleaseSupersededAfterPersist`, `reassertSupersededLiveRow` and the dead rewrite chain                                                                                                                                                                                    | S    | Dead-code check; full row-invariant suites                                                                                                                                                                                                                      |

## 7. Risks

- Concurrency core: orderings that exist only as comments (a non-terminal release must
  not yield after freezing its reason; the fence "with no await in between") become
  methods that must stay synchronous, each with a test asserting no microtask boundary
  (the S2 harness counts awaits).
- Dual representation during S3-S6 could disagree; mitigated by the S2 agreement test
  and deleting each group's legacy maps in the PR that made its slice authoritative.
- Weak references: `ended` records must not extend a `Session`'s lifetime (GC seam
  test in S6).
- `settled` promises can hide unhandled rejections; they resolve, never reject.
- W4 changes durability semantics. It is gated on `durable` (Noop and failed append
  keep today's order), W1 lands first, and a bug in the `durable` signal is the worst
  case (a revived UUID), so the fault-injection test fails the signal itself.
- Multi-daemon rows: no SQL guard is removed in any step; W2 adds the generation guard
  against late parked statements. A wedged write delays that UUID's next issued row only
  until its persistence deadline.
- Unchanged and out of scope: derived-label maps, restore queues, per-device cleanup
  bookkeeping, the `Session` shape and the MCP surface.

## 8. Open decisions

1. Is one `fenced` state enough for the `forced`, `journal` and `peer-journal` sources,
   or must a forced terminal release stay distinguishable (#11361)? `source` stays a
   field so it can split later.
2. W4 on Windows: the journal's directory fsync is skipped there. Decide whether
   `volatile` is the right answer on Windows or document the weaker guarantee.
