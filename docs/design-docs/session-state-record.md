# Session state record

Design note for #11798 (one explicit state record per session UUID) and the two "Not verified"
questions of #11799 (one serialized per-UUID row writer). The S2 agreement findings below
record the implemented shadow-only mapping; the remaining migration is proposed. Line numbers are
`src/daemon/sessionManager.ts` at `4f6d25591e` unless a path says otherwise; the file is 13,903
lines.

## Summary

- A session UUID's lifecycle is the conjunction of membership in about 17 maps and sets plus flags
  on three records. Six hand-written predicates each read a different subset of them.
- Proposed: a `SessionSlots` store holding one `SessionSlot` per UUID, a discriminated union with
  explicit transitions that assert the from-state. It holds no I/O and no durable-row logic.
- #11799's `SessionRowWriter` sits beside it, not inside it. Slots emit "desired row" intents; the
  writer owns every status-changing `device_sessions` write for the UUID. Slots only read
  `rowPending`.
- The two #11799 questions: the journal is durable enough for terminal intents **only on the
  daemon path and only when its append succeeded**, so the writer must be told whether it did
  (verdict 1). Freeing the device before the terminal row lands is **acceptable only when the
  intent is durable**, and is already the norm for non-terminal releases and two terminal paths
  (verdict 2).
- Migration: nine behaviour-preserving steps for #11798 (introduce in parallel, switch, delete;
  the query/command split S8 is tracked as its own issue), then five for #11799, of which exactly
  one (W4) changes ordering and one (W2) adds a SQL guard.

## 1. Current state (evidence)

### 1.1 Per-UUID lifecycle state

Every field is a private member of `SessionManager` (1613-1860). `U` = keyed by UUID,
`S` = keyed by `Session` object identity (a `WeakMap`/`WeakSet`).

| Concern                | Field (line)                                                                                                            | Key         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------- |
| Published              | `sessions` (1614)                                                                                                       | U           |
| Device index           | `sessionDeviceMap` (1615), `deviceSessionMap` (1616)                                                                    | U / device  |
| Assignment             | `pendingSessionAssignments` (1800), `sharedSessionAssignments` (1801)                                                   | U           |
| Creation               | `pendingSessionCreations` (1796), `pendingPersistedRecoveries` (1803), `claimedRecoverableRows` (1805)                  | U / S       |
| Rebind                 | `pendingSessionRebinds` (1847), `deferredRebindCleanups` (1848)                                                         | U           |
| Release before publish | `pendingSessionReleases` (1845)                                                                                         | U           |
| Release in flight      | `releasePromises` (1651), `activeReleasePromises` (1653), `releasingSessions` (1740)                                    | U / set / S |
| Terminal fence         | `terminalReleaseSnapshots` (1856), `terminalReleaseReasonStates` (1733), `terminalReleaseReservations` (1735)           | U           |
| Finalized identity     | `finalizedSessionReleases` (1688), `latestFinalizedSessionIdentities` (1723), `finalizedSessionIdentityRegistry` (1724) | S / U       |
| Forced release         | `forcedNonTerminalReleases` (1694)                                                                                      | S           |
| Journal recovery       | `recoveredTerminalReleaseIntents` (1679), `adoptedDeadDaemonJournals` (1681), `adoptedTerminalReleaseOwners` (1686)     | U / daemon  |
| Row facet (see 1.3)    | 17 fields, 1660-1665, 1703-1721, 1822-1843, 1857                                                                        | U / S       |

Flags on records carry more lifecycle: `forced`, `commitFenced`, `commitDeclined`, `stage`
(`SessionReleaseOperation`, 990-1026) and `terminalPersisted`, `lateTerminalRelease`,
`finalizedSnapshot` (`ReleaseReasonState`, 952-957).

Out of scope, keyed by UUID but not lifecycle: derived-label maps (`derivedLabelSessionsByBase`
1630, `endedLabelBases` 1632, `planLabelMints`, `runningPlanLabelSessions`), restore queues and
mutation chains (`clock*`, `rotation*`, `screenReader*`, `networkCondition*`), and per-device
cleanup bookkeeping. They stay as they are; only `endedLabelBases` is touched by a transition.

### 1.2 Hand-written predicates

| Predicate                 | Line  | Reads                                                                                                                     |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| `isCurrentSession`        | 6558  | `sessions`, `terminalReleaseSnapshots`                                                                                    |
| `isAdmittedForAutomation` | 6565  | the above + `releasingSessions`                                                                                           |
| `isLatestSessionIdentity` | 6581  | `sessions`, `pendingSessionCreations`, `pendingSessionAssignments`, `releasePromises`, `latestFinalizedSessionIdentities` |
| `isSessionBeingRecreated` | 9366  | `sessions`, `pendingSessionCreations`, `pendingSessionAssignments`                                                        |
| `getAllKnownSessionIds`   | 13092 | six maps                                                                                                                  |
| `getHeldDeviceSessions`   | 6521  | `deviceSessionMap`, `sessions`, `releasePromises`                                                                         |

"Releasing" is tracked three ways: by object (`releasingSessions`), by id (`releasePromises`) and by
operation (`activeReleasePromises`). `waitOutRecreationOf` (8311) is a workaround for the scatter:
it yields because the maps are cleared by another continuation. `getSession` (4526) is not a
query: `getSessionInternal` (4543-4580) starts a release when it finds an expired session
(`releaseExpiredSessionLazily`). It has 31 in-class callers and about 84 external ones; the
side-effect-free `peekSession` (12063) has 9 external callers.

### 1.3 Durable row writes (the row facet)

Every `device_sessions` write, by site:

| Write                      | Site                                                                                     | Repository call                                       |
| -------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Create / recovery claim    | `persistSession` via `persistAndPublishSession` (3775)                                   | `upsertActiveSession` (13452)                         |
| Rebind                     | `persistAndPublishRebind` -> `persistSession` (6014)                                     | `upsertActiveSession`                                 |
| Superseded-row rewrite     | `reassertSupersededLiveRow` (7892), `replaceSupersededReleaseRow` (8276)                 | `upsertActiveSession`                                 |
| Activity                   | `persistSessionActivity` (13676)                                                         | `recordActivity` (13681)                              |
| Activity repair            | `rePersistSessionActivity` (13717)                                                       | `upsertActiveSession`                                 |
| Release (terminal and not) | `persistSessionRelease` (8813)                                                           | `markReleased` (8836)                                 |
| Release retry              | `retryTerminalReleaseWrite` (9113)                                                       | `markReleased` (9124)                                 |
| Startup intents            | `applyRecoveredTerminalReleaseIntents` (1957)                                            | `markReleased` (1972)                                 |
| Peer-dead intents          | `fenceDeadDaemonIntents` (2088)                                                          | `markReleased`                                        |
| Expired persisted          | `terminalizeExpiredPersistedSession` (4296), `tryReleaseUnrecoveredReissuableRow` (7008) | `markReleased`                                        |
| Liveness owner             | 12263, 12768, 12874, 13501                                                               | `recordLivenessOwnership`, `replaceLivenessOwnership` |

Today's guards live in SQL, not in memory: `expectedRowGeneration`, `unlessTerminal`,
`unlessTerminalOrOwnedByLivePeer` (`src/db/deviceSessionRepository.ts` 271-385), and, since
#12463, `activity_seq` (303, 318, 525-563): an activity write only overwrites activity columns when
its session-clock sequence is not older than the row's, and `recordActivity` only matches
`status = active`. Activity writes are therefore commutative and cannot revive a terminal row, so
they do not need the writer's serialization; they need only a way to report "row not active" to it.
#12465 made every `DeviceSessionPersistence` method required (389-470), so a writer can be built on
one complete interface and one complete in-memory fake (`test/fakes/FakeDeviceSessionPersistence.ts`).

The "patch-on-patch" chain of #11799 is visible in the fields: superseded-release state is
`supersededReleaseReasons` (1712), `pendingSupersededRowReasserts` (1822),
`supersededRowsUnderPendingRelease` (1827), `supersededReasonsBeingRewritten` (1836),
`owedSupersededRowReasserts` (1842), `releaseReasonPredecessors` (1716), `refusedReleaseWrites`
(1721) and the backoff (1843); two retry record types (`TerminalReleaseRetry` 963,
`OwedSupersededRowReassert` 972) have the same shape.

### 1.4 Release ordering today

`releaseSessionInternal` (7232-7365):

1. Teardown (7243-7250), then the first supersede fence (7263).
2. Terminal only: `persistTerminalReleaseWithinDeadline` (7302) raises the in-memory fence
   (`terminalReleaseSnapshots.set`, 9405), then `persistSessionRelease` records the journal intent
   (8827) **before** issuing `markReleased` (8836), bounded by `SESSION_RELEASE_PERSIST_TIMEOUT_MS`
   (1379) = `SESSION_RELEASE_DRAIN_TIMEOUT_MS` (5 s, `constants.ts` 538) + 1 s = **6 s**. The issue
   text says 10 s; that is the teardown cap (`SESSION_RELEASE_TEARDOWN_CAP_MS`, 1370), a different
   bound. At the deadline the device is freed anyway (7807-7813).
3. Final supersede fence (7315), synchronous with the commit. A decline here is what forces
   `abandonReleaseSupersededAfterPersist` (7843) and the rewrite chain.
4. `commitReleaseRemoval` (7325) removes the session and frees the device.
5. Non-terminal only: the row is written **after** the commit (`completeReleasePersistence`, 8687,
   called at 7341), retried through `pendingNonTerminalReleaseSnapshots` (#11557).

A forced stuck release (`forceStuckRelease`, 3303) also frees the device first and persists later
(`persistForcedReleaseFence`, 3425).

## 2. The two #11799 questions

### Q1. Is the journal durable enough to carry "ended but row not yet written" everywhere?

**Verdict: no, not everywhere. Yes for terminal intents on the daemon path, provided the append
succeeded. The writer must be told whether it did.**

What holds (`src/daemon/terminalReleaseJournal.ts`):

- Real implementation `FileTerminalReleaseJournal` (178): one append-only JSONL file per daemon in
  `<dataDir>/terminal-release-intents/`. `appendDurable` is write + `fsyncSync` (365-374), and runs
  before the DB write is issued (`sessionManager.ts` 8827 precedes 8836). Compaction is
  write-sibling, fsync, rename, fsync directory (375-398).
- Crash after the intent and before the row: the next start applies it
  (`applyRecoveredTerminalReleaseIntents`, 1957, run first in `rehydratePersistedSessions`, 5502).
  A dead peer's file is adopted at startup (436-467) or when the peer is found dead later
  (`readDeadDaemon`, `fenceDeadDaemonIntents` 2088, #11355).
- Shutdown: `drainReleasePromises` (7137) awaits releases, parked late writes and one immediate
  retry round before the DB closes; a timed-out drain keeps the DB open and the intent on disk.
- Tests: `sessionManager.releasePersistDeadline.test.ts` ("a crash after the intent, before the
  write lands, restarts with the UUID terminal"; "a torn tail after the intent is ignored").

What does not hold (each is a gap):

1. `record()` swallows an append failure and logs at warn (`terminalReleaseJournal.ts` 223-236);
   `persistSessionRelease` then issues the write regardless. That release has no crash safety and
   nothing says so. Under free-before-row this becomes a revival window.
2. The default is `NoopTerminalReleaseJournal` (`sessionManager.ts` 1668). The only attach is
   `daemon.ts` 1834, inside `Daemon.startOn`; the only `new SessionManager(` is `daemon.ts` 925.
   Anything not started through `Daemon.startOn` has no durability, and every unit test runs with
   Noop unless it opts in.
3. The first append to a new file does not fsync the parent directory (365-374); only compaction
   does (394-397). A newly created per-daemon file's directory entry may not survive a crash.
4. A corrupt line in the middle of the file drops that intent at debug level (121-146); only a
   torn final line is handled deliberately.
5. If compaction fails and the lift-marker append also fails, a stale intent can survive and
   terminalize a live session on restart (238-261).
6. It carries **terminal** intents only. A non-terminal "ended, row not yet written" (device
   restart) lives only in `pendingNonTerminalReleaseSnapshots`; a crash leaves the row active,
   and rehydration recovers it. For a non-terminal reason that is the intended outcome, so the
   journal need not carry it.

What a missing intent does after a crash: a stale `active` row with no release reason is expired to
`daemon-restart` by `markStaleActiveSessionsExpired` (`daemon.ts` 5201; repository 1043-1084),
which makes it recoverable and listable; rehydration then reserves its device by stable id
(`sessionManager.ts` 5579-5612). So the failure is a revived UUID and a phantom hold on a device
that may belong to another session. The journal replay (5502) runs before the listing (5504);
the ordering against `daemon.ts` 5201 was read, not run, and is checked in W1.

Required before relying on it: `record()` returns whether the intent is durable
(`"durable" | "volatile"`); the Noop journal returns `"volatile"`; fsync the directory on first
create; log a mid-file corrupt line at warn. These are journal-only changes (step W1).

### Q2. Is freeing the device before the terminal row lands acceptable?

**Verdict: acceptable when the intent is durable. It already happens on three paths; the proposal
makes it the single path for terminal releases and adds the missing condition.**

Evidence it already happens:

- Terminal deadline path: `persistTerminalReleaseWithinDeadline` (7794-7817) frees the device after
  6 s with the row unwritten; the in-memory fence (9405, raised before the write) keeps the UUID
  from routing. `sessionManager.releasePersistDeadline.test.ts` (113) asserts the device is held one
  ms before the deadline and freed at it with the snapshot kept.
- Forced stuck release: `forceStuckRelease` (3303-3364) returns the device, then
  `persistForcedReleaseFence` (3425).
- Every non-terminal release writes its row after the commit (7341).

Why it is safe:

- Device allocation does not read `device_sessions`. `getSessionForDevice` (6516) and
  `getHeldDeviceSessions` (6521) read only `deviceSessionMap`; `devicePool.ts` calls the repository
  only for `markAutolockSession`. A stale row cannot cause a double assignment.
- The in-memory fence is raised before the write and never depends on it.
- Peers: `markStaleActiveSessionsExpired` spares a live peer's active rows, and
  `claimRecoverableSession` requires a non-active row with a re-issuable reason (repository
  778-806), so a stale active row cannot be claimed.

Risks, and the condition that bounds each:

1. Crash window between the free and the row landing. Covered only if the intent is durable (Q1).
   Rule: **free before the row only when `journal.record` returned `durable`; otherwise write
   first, bounded by the existing deadline, as today.** On Noop and after a failed append this
   keeps today's order exactly, so direct mode and unit tests see no change.
2. Ghost `active` row. Between the free and the landing, the old UUID's row stays active with no
   reason. Readers: startup rehydration (above), UUID-only recovery (`readPersistedSession`, 4086),
   admission (`createUnseenSession` treats only a terminal row as blocking, 5120-5128), video
   recording reclaim (`videoRecordingRepository.ts` 249-255, operational phantom hold only) and the
   appearance sweep (cosmetic). Within a live process the in-memory fence decides, not the row.
3. **Existing gap this design must close: a terminal write carries no generation.**
   `releaseWritePrecondition` (8657-8662) sets `expectedRowGeneration` only for non-terminal and
   `daemon-shutdown` releases, and `livePeerDaemonSessionIds` is hard-coded empty (8670). A parked
   terminal write can therefore land on a row the same daemon re-upserted for the same UUID after
   the fence was lifted (7826, 11716); only the in-memory fence prevents it. No test reproduces it
   (read, not run). The per-UUID writer closes it by construction: a parked write keeps the UUID's
   writer busy, so a later `live` desire waits for it to settle and then overwrites it as a new
   generation, never the other way round. The cost: that UUID's next create row waits behind a
   wedged write, bounded by `withinCreateDeadline`. Whether production `markReleased` can interleave
   at all (bun:sqlite is synchronous) is to be confirmed in W2; if it cannot, the gap exists only on
   the retry and park paths and the regression test is scoped to them.
4. Wedged writer. A per-UUID writer holds one coalesced intent per UUID, not a queue of parked
   writes (`lateReleaseWrites` can hold several per UUID today).
5. Part two of #11799 removes the superseded-after-persist path. After a free-before-row commit a
   later supersede arrives after the commit and is refused (the release already won) rather than
   rewritten. That is sound only because the final fence, the journal append and the commit are all
   synchronous (no `await` between them), so nothing can interleave.

A fault-injection test (§6, W2) makes the claim checkable: fail the journal append, the row write
and the process at each await and assert the post-restart row equals the in-memory outcome.

## 3. Proposed per-UUID record

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
  /** Older incarnations whose release has committed but is still finalizing (activeReleasePromises). */
  retiring: ReadonlySet<SessionReleaseOperation>;
  /** Resolves when the slot next changes tag; replaces the microtask-yield loops. */
  settled: Promise<void>;
}
```

Rules:

- Incarnation identity stays "the `Session` object in the record" (`state.session`, or
  `identity.deref()` after the session is gone). Nothing about `Session` changes.
- Per-incarnation history stays in identity-keyed side tables (`WeakMap<Session, ...>`):
  `finalizedSessionReleases` (1688) and the per-`Session` row-facet maps. They are not lifecycle,
  and they must outlive the slot being reoccupied (`ended` -> `creating`), because
  `releaseFinalizedSession` (8723) and `releaseThatEnded` (8137) read an older incarnation's
  `ReleaseReasonState` while a newer one is live. Only the UUID-keyed lookup of the latest
  identity moves into the slot.
- The row is not a field of the slot. `rowPending` is a read-through to the writer (§5).
- `ended` records are weak with respect to the `Session` and are evicted by the existing
  `FinalizationRegistry` mechanism, so a long-lived daemon does not accumulate UUIDs. A `fenced`
  record is not evicted by GC: a terminal fence is permanent until lifted, as
  `terminalReleaseSnapshots` is today. That unbounded growth is inherited and out of scope.
- The device index (`sessionDeviceMap`, `deviceSessionMap`) stays beside the store, maintained by
  the same transitions, because it is keyed by device.

### 3.1 Legal transitions

Each is a method on `SessionSlots` that asserts the from-state. An illegal transition throws in
tests and, until the legacy maps are deleted (S7), logs at warn and keeps the legacy behaviour in
production.

| From                          | To                                          | Cause (today's code)                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| absent                        | `assigning`                                 | automatic device assignment starts                                                                                                                                                           |
| absent                        | `creating`                                  | `createSession` (3557)                                                                                                                                                                       |
| absent                        | `fenced`                                    | startup or peer journal intent (1957, 2088); a refused creation or an expired persisted row terminalized at admission (`terminalizeExpiredPersistedSession`, 4296; journal use at 4018-4026) |
| `assigning`                   | `creating`                                  | device chosen, creation write starts                                                                                                                                                         |
| `assigning` / `creating`      | absent                                      | assignment or creation failed or abandoned (`abandoned`, 946)                                                                                                                                |
| `creating`                    | `live`, or `releasing`                      | publish; a recorded `releaseRequested` starts the release at once (7076)                                                                                                                     |
| `ended`                       | `creating`                                  | non-terminal release followed by recovery or revival                                                                                                                                         |
| `fenced`                      | `creating`                                  | only via a lift: reservation owner (`rebindSessionForTerminalReleaseRecovery`, 5980), plan-label mint (11716)                                                                                |
| `live`                        | `rebinding`                                 | `rebindSession` (5894)                                                                                                                                                                       |
| `rebinding`                   | `live`                                      | rebind published or rejected                                                                                                                                                                 |
| `live`                        | `releasing`                                 | `releaseSessionAttempt` (6666)                                                                                                                                                               |
| `rebinding`                   | `releasing`                                 | a release started during a rebind waits in stage `awaiting-rebind` (6748, 6779); the rebind promise moves to `releasing.rebind`; a forced release does not wait                              |
| `releasing`                   | `ended`                                     | non-terminal commit (7325-7335)                                                                                                                                                              |
| `releasing`                   | `fenced`                                    | terminal commit                                                                                                                                                                              |
| `releasing`                   | `ended` or `fenced` with `source: "forced"` | `forceStuckRelease` (3303-3341) while the op is still in teardown: the op moves to `retiring` and later returns null at 7257 / 7307                                                          |
| `releasing` (`fence: "none"`) | same state, `fence: "terminal"`             | a terminal release upgrades the shared reason (the 7295 comment). The only legal mutation without a tag change                                                                               |
| `ended`                       | absent                                      | the session is garbage-collected and nothing waits on the slot                                                                                                                               |
| `releasing`                   | `live`                                      | supersede declined (`commitDeclined`, 7263, 7315); terminal fence lifted                                                                                                                     |
| `releasing`                   | `retiring` entry on the next slot state     | commit while finalizing (7341)                                                                                                                                                               |

Unreachable: `rebinding` -> `ended`, `fenced` -> `live`, `ended` -> `fenced` (a terminal upgrade
happens while `releasing`). Under the slot design `commitReleaseRemoval` returning false (7405)
is unreachable: the from-state assertion replaces it.

Rebind during release: `rebindSession` awaits an in-flight release and then throws unconditionally
(5924-5928), even when the release was declined and the session is `live` again. The slot design
replaces it with `await slot.settled` and a re-dispatch on the new tag; that is the one place S7
could change behaviour, so it ships with its own test and is called out in the PR.

## 4. Mapping of existing state

| Existing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | New home                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `state.session` of `live` / `rebinding` / `releasing`                                                                                         |
| `pendingSessionAssignments`, `sharedSessionAssignments`                                                                                                                                                                                                                                                                                                                                                                                                                                              | `assigning`                                                                                                                                   |
| `pendingSessionCreations`, `pendingPersistedRecoveries`, `claimedRecoverableRows`                                                                                                                                                                                                                                                                                                                                                                                                                    | `creating.creation`, `creating.recovery`                                                                                                      |
| `pendingSessionReleases`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `releaseRequested` on `assigning` / `creating`                                                                                                |
| `pendingSessionRebinds`, `deferredRebindCleanups`                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `rebinding.rebind` or `releasing.rebind` (cleanups stay a per-slot list)                                                                      |
| `releasePromises`, `releasingSessions`, `forced`, `commitFenced`, `stage`                                                                                                                                                                                                                                                                                                                                                                                                                            | `releasing.op` (`releasingSessions` is `tag === "releasing"`)                                                                                 |
| `activeReleasePromises`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `releasing.op` plus `retiring` (a derived set across slots)                                                                                   |
| `terminalReleaseSnapshots`, `terminalReleaseReasonStates`                                                                                                                                                                                                                                                                                                                                                                                                                                            | `fenced.snapshot` / `fenced.reason`; `releasing.fence`                                                                                        |
| `terminalReleaseReservations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `fenced.reservation`                                                                                                                          |
| `latestFinalizedSessionIdentities`, registry                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `ended.identity` / `fenced.identity`                                                                                                          |
| `finalizedSessionReleases` (S-keyed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | stays an identity-keyed side table (see §3 rules)                                                                                             |
| `recoveredTerminalReleaseIntents`, `adoptedTerminalReleaseOwners`, `adoptedDeadDaemonJournals`                                                                                                                                                                                                                                                                                                                                                                                                       | `fenced` with `source: "journal"` / `"peer-journal"` (the adopting owner stays on the snapshot); the dead-daemon set stays a daemon-level set |
| `forcedNonTerminalReleases`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `ended.source = "forced"` plus the snapshot; the stuck op lives on in `retiring`                                                              |
| Row facet: `pendingTerminalReleaseRetries`, `lateReleaseWrites`, `releaseDrainStarted`, `pendingNonTerminalReleaseSnapshots`, `owedSupersededRowReasserts`, `pendingSupersededRowReasserts`, `supersededRowsUnderPendingRelease`, `supersededReasonsBeingRewritten`, `supersededReleaseReasons`, `releaseReasonPredecessors`, `refusedReleaseWrites`, `releaseRowGenerations`, `persistedRowGenerations`, `issuedActivityWrites`, `retiredCreationRows`, `activityRowRePersists`, the retry backoffs | `SessionRowWriter` (#11799); #11798 does not move them                                                                                        |

Predicate mappings (including the design-visible S2 shadow resolutions):

- `isCurrentSession(s)`: `slot.session === s` and tag in {`live`, `rebinding`}, or `releasing` with
  `fence: "none"`.
- `isAdmittedForAutomation(s)`: current identity with no terminal fence and not in
  `releasingSessions` during the shadow migration. See the S2 mapping below before replacing this
  with a tag-only read.
- `isLatestSessionIdentity(s)`: the slot's identity equals `s` (`creating` / `assigning` -> false).
- `isSessionBeingRecreated(u)`: tag in {`assigning`, `creating`, `live`, `rebinding`, `releasing`}.
- `getAllKnownSessionIds()`: ordinary occupied tags, plus any `residue` flagged record, including
  `absent`, `ended` and `fenced` during the shadow migration.
- `getHeldDeviceSessions()`: the device index joined with the slot's `session`.

`waitOutRecreationOf` / `waitOutReleaseOf` / `waitOutRebindOf` become `await slot.settled`.

### S2 agreement findings

These are design-visible S2 resolutions, preserving the existing predicates and all lifecycle
behaviour. `getLegacyLifecycleView()` borrows the nine real maps through read-only interfaces;
`isReleasing(session)` reads the identity-keyed WeakSet without enumerating it. Ten one-statement
hooks observe creation/assignment start and end, publication, rebind start/end, release start/end,
and unpublication (shared by ordinary and forced release). Production defaults to `log`:
disagreements use `logger.debug`; exceptions from derivation/predicates are caught and warned.
Tests set `throw`; `off` performs no reads. No probe result controls a lifecycle operation.

1. **Published releases are still being recreated.** `releasing` joins the recreation tag set.
   The WeakSet add precedes release-op installation, so that window also derives `releasing`.
   S7 must preserve this meaning rather than treating recreation as only creation work.
2. **A declined commit does not override a terminal fence.** Any published session with a held
   terminal snapshot derives `releasing` with `fence: "terminal"`, including declined operations.
   Current/admission remain false, known/recreated remain true. A real failed terminal write also
   leaves a published session and fence with **no release operation**, even after settling;
   deterministic coverage reproduces it and a later declined release. Thus the shadow
   `releasing` tag cannot require an op payload. S5 must represent that held-fence state before
   replacing the legacy maps. A newly raised fence can instead be lifted during a declined
   release's live-row rewrite; `releasing -> live` remains legal.
3. **Orphan bookkeeping is known residue.** `DerivedSlot.residue: true` retains membership for
   `pendingSessionReleases`, `pendingSessionRebinds`, or `releasePromises` after publication,
   creation and assignment are gone. It may decorate `absent`, `ended` or `fenced`;
   `deriveAllSlots` includes an absent residue. The sweep observes orphan release requests;
   a controlled forced release during a parked rebind reproduces an orphan rebind. Both clear
   when outstanding work settles; a parked await can retain them indefinitely. S3/S4 must retain
   these outstanding-work records in known-id reads until their continuations clean up, or
   explicitly prove equivalent atomic cleanup. They must not silently drop them as absent.
4. **Admission is not yet tag-only.** Release operations outlive removal, and can also outlive
   WeakSet cleanup on a published incarnation. A non-terminal `releasing` tag can therefore be
   current and admitted after that cleanup; a terminal-fenced published session remains blocked
   even without WeakSet membership. The exact S2 mapping is current-by-tag/fence, then
   `!view.isReleasing(publishedSession)` for admission. S5/S7 must preserve those windows before
   collapsing admission to tags. Superseded/stale ops never replace a newer published identity.
5. **Known and latest identity have separate precedence.** An unpublished release op remains
   known even when its tag is `ended`/`fenced` (the same residue flag). Latest identity chooses
   published, then rejects pending creation/assignment, then release-op identity, then the weak
   finalized identity. The probe checks all three candidates and tests also retain older
   incarnations. `getHeldDeviceSessions` is outside S2: it joins the separate device index and is
   not a UUID-only predicate.

The production known-id check is the constant-time six-map membership equivalent of
`getAllKnownSessionIds()`, not an allocation of its complete union per hook. The agreement test
additionally checks membership against the real public union after operations and individual
microtask yields. Its 29 seeds (including a pinned corpus), 36 random steps per seed and three
forced reincarnations run in `beforeAll`; the timed per-seed tests only assert results. It also
performs a shutdown drain and rehydrates a guaranteed recoverable row with the shared in-memory
persistence and journal filesystem. It uses no devices or SQLite.

## 5. Where `SessionRowWriter` sits

```
SessionManager
 |-- SessionSlots (sync, pure, no I/O)        -- tag, session, op, fence, retiring
 |       | emits desired-row intents on transitions
 |       v
 |-- SessionRowWriter (async I/O, per-UUID)  -- desired row, one in-flight write, one backoff
 |       |-- DeviceSessionPersistence (#12465 interface)
 |       `-- TerminalReleaseJournal           -- record() before a terminal intent is queued
 `-- activity writes: direct `recordActivity` (commutative via activity_seq)
```

- Direction: slots -> writer. The writer never reads slots. The supersede decision is made by the
  transition (the intent is replaced before it is written), so "a stale write landed over a newer
  row" and "the rewrite is owed" stop being cases.
- The writer exposes `desire(uuid, DesiredRow)`, `pending(uuid): boolean` (read by slots as
  `rowPending`), `settled(uuid): Promise<void>` and `drain(): Promise<void>` (shutdown, called
  where `drainReleasePromises` is today).
- A `DesiredRow` is a full row image, so replacing an unwritten desire is sound:
  `live(binding, activity) | released(reason, binding) | terminal(reason, binding, journaled)`.
  `released` and `terminal` carry the binding because `markReleased` is an UPDATE: if the row does
  not exist yet (a `live` desire was replaced before it was written) the writer upserts with the
  release status instead. Replacement applies to an **unwritten** desire only. A write that has been
  issued, including one parked past its deadline, is in flight: a later desire waits for it to
  settle and is then written as a new generation. A terminal desire is never replaced by a
  non-terminal one unless the slot has been lifted (`fenced` -> `creating`).
- Writer invariant: **an intent on disk implies the slot is `fenced`** (or `releasing` with
  `fence: "terminal"`). Startup replay (1964-1970) has no generation guard, only "the row's reason is
  not terminal", so every path that replaces or refuses a durable terminal intent must call
  `journal.resolve` synchronously with the transition: the `fenced` -> `creating` lift (today 7826
  and 11716), a superseded fence, and a terminal write the new generation guard refuses. Otherwise
  a restart would terminalize a newer incarnation of the same UUID.
- Cross-daemon safety keeps `expectedRowGeneration` and `unlessTerminal*` in SQL. The writer adds a
  generation guard to terminal writes (Q2 risk 3); this is a guard change, named as such in W2.
  Before classifying a generation advance as foreign, the current release path awaits that
  incarnation's in-flight own row writes after reading the row (#12547). The existing persistence
  deadline bounds this wait; writes from other incarnations remain protected by the guard.
- Terminal ordering rule (Q2): `desire(terminal)` is called synchronously after the final fence and
  after `journal.record` returned `durable`; the commit then frees the device. When `record`
  returned `volatile` the release awaits the write first, bounded as today.
- Activity: `recordActivity` stays direct. On `DeviceSessionNotActiveError` it does not call the
  writer. It reports `rowLost(uuid)` to the slots, which re-emit `desire(live)` only when the tag is
  `live` or `rebinding`; the `unlessReleased` SQL guard (repository 286) stays. This keeps the
  direction slots -> writer and prevents a revival when the row is inactive because a terminal
  release landed.
- The commit sequence (final fence, `journal.record`, `desire`, slot transition and device free) is
  one synchronous method with no `await`, so the ordering stops being a comment.

## 6. Staged migration

Principles: introduce in parallel, assert agreement, switch reads, delete maps one group per PR.
Every PR is behaviour-preserving, adds no public API, and keeps unit tests under 100 ms (FakeTimer,
in-memory `FakeDeviceSessionPersistence`, `FakeTerminalReleaseJournalFileSystem`). #11784 (per-file
line-count ratchet) lands first so extracted modules cannot grow back. Each PR runs
`bash scripts/prepush-node.sh` and `bash scripts/prepush-integration-safe.sh`.

New code goes in proposed modules (SessionSlots and SessionRowWriter) so
`sessionManager.ts` shrinks monotonically.

### Part A: #11798

| #   | PR                                                                                                                                                                                                                                                                                                                                                                                                                   | Size                   | Test plan                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Types, transition table and pure `deriveSlotTag(legacyView)` in the proposed SessionSlots module. No wiring.                                                                                                                                                                                                                                                                                                         | S (~300 new lines)     | Table-driven: every legal transition accepted, every other rejected; derivation for each tag from hand-built legacy views.                                                                           |
| S2  | Shadow probe: `SessionManager.lifecycleTagOf(uuid)` derived from legacy maps, plus a random-interleaving agreement test (create / rebind / release / force / supersede / restart) under `FakeTimer`, seeded, asserting derived tag and the six predicates agree after every await.                                                                                                                                   | M (~400 test, ~40 src) | The property test is the PR. Seed corpus pinned; 100 ms per case by capping steps. Also run against the `sessionManager.rowInvariant` scenarios.                                                     |
| S3  | `SessionSlots` becomes the store for the assignment and creation group (`pendingSessionAssignments`, `sharedSessionAssignments`, `pendingSessionCreations`, `pendingPersistedRecoveries`, `claimedRecoverableRows`, `pendingSessionReleases`). Legacy maps deleted in the same PR.                                                                                                                                   | M                      | `sessionManager.test.ts`, `cancelledClientChosenId` and rehydration tests unchanged; S2 stays green.                                                                                                 |
| S4  | Rebind group (`pendingSessionRebinds`, `deferredRebindCleanups`).                                                                                                                                                                                                                                                                                                                                                    | S                      | `sessionManager.rebindTtlRestoreShield`, rebind tests; S2.                                                                                                                                           |
| S5  | Release group: `releasePromises`, `activeReleasePromises`, `releasingSessions`, `forcedNonTerminalReleases` collapse into `releasing.op` and `retiring`. Highest risk: every await in `releaseSessionInternal` re-reads these.                                                                                                                                                                                       | L                      | `releasePersistDeadline`, `releaseTeardownShield`, `releaseDeviceHold`, `abandonRestoreSingleBaseline`; S2 extended with forced and stuck releases; a new test for the single "releasing" invariant. |
| S6  | Fence and identity group: `terminalReleaseSnapshots`, `terminalReleaseReasonStates`, `terminalReleaseReservations`, `latestFinalizedSessionIdentities`, recovered and adopted intents. `finalizedSessionReleases` stays a side table.                                                                                                                                                                                | L                      | `releasePersistDeadline` journal cases, `devicePool.recoveryShutdown`, terminal-reservation tests; GC test through a fake `FinalizationRegistry` seam.                                               |
| S7  | Predicates become tag reads; the six hand predicates are deleted; `waitOut*Of` use `slot.settled`. An illegal transition throws under test and logs a warning plus a counter in production, so this PR stays behaviour-preserving. The rebind-during-release re-dispatch (§3.1) is split into its own PR if it changes behaviour.                                                                                    | M                      | S2, plus the unit tests of each predicate's call sites and one test per removed microtask-yield workaround.                                                                                          |
| S8  | Its own issue, not part of closing #11798. Split `getSessionInternal` into pure `find` and explicit `expireIfDue`; migrate the 31 in-class readers (`getClock`, `getRotation`, `getNetworkCondition`...) to `find`. `expireIfDue` stays at every site where expiry is observable (routing, admission), so lazy expiry does not silently disappear for the 84 external callers; those migrate directory by directory. | M, then several S      | A lint-guarded test that `find` never schedules a release; the expiry tests move to `expireIfDue`.                                                                                                   |
| S9  | Hand-off: slot code no longer reads row-facet fields; `rowPending` is the only row signal (stubbed `() => false` until W2). Closes #11798.                                                                                                                                                                                                                                                                           | S                      | Existing row-invariant suites unchanged.                                                                                                                                                             |

S1 and S2 can run in parallel with W1. S3-S6 are independent of each other but touch the same file,
so they merge serially. S8 can ship any time after S2 and is tracked separately.

### Part B: #11799 (blocked by S9, except W1)

| #   | PR                                                                                                                                                                                                                                                                                                                                  | Size | Test plan                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Journal hardening, independent of everything: `record()` returns `durable` / `volatile`; directory fsync on first create (skipped on win32 like 394-397); warn on mid-file corruption; Noop returns `volatile`; verify and pin the restart ordering of `daemon.ts` 5201 against journal replay.                                     | S    | Journal unit tests with `FakeTerminalReleaseJournalFileSystem`: failed append gives `volatile`, crash simulation, torn and mid-file corruption; a restart-ordering test that includes the `deadlineAt` break case (1960-1962), where unapplied intents meet `daemon.ts` 5201. |
| W2  | `SessionRowWriter` for release rows only; replaces `pendingTerminalReleaseRetries`, `lateReleaseWrites`, `pendingNonTerminalReleaseSnapshots`. Same ordering (terminal row before commit). Adds the terminal generation guard (Q2 risk 3), a guard change paired with the journal-lift invariant (§5); it is named in the PR title. | L    | `releaseRowRetry`, `releasePersistDeadline`, `rowInvariant` unchanged; new fault-injection test that fails each write kind at each await and asserts the final row equals the final in-memory outcome; a regression test for the same-UUID overwrite.                         |
| W3  | Create / rebind / activity-repair writes move to the writer; the superseded-row fields and `OwedSupersededRowReassert` are deleted.                                                                                                                                                                                                 | L    | `supersededRowReassertRetry`, `rowWritesRemainingCases`; fault-injection extended.                                                                                                                                                                                            |
| W4  | Behaviour change, isolated: terminal write after the final fence when `journal.record` is `durable` (§5). The only PR that changes ordering.                                                                                                                                                                                        | M    | Crash after free; record failure falls back to write-first; supersede after commit is refused; Linux and macOS CI.                                                                                                                                                            |
| W5  | Delete `abandonReleaseSupersededAfterPersist`, `reassertSupersededLiveRow` and the rest of the now-dead rewrite chain.                                                                                                                                                                                                              | S    | Dead-code check; full row-invariant suites.                                                                                                                                                                                                                                   |

## 7. Risks

- Concurrency core. Orderings that exist only as comments (7295 "a non-terminal release must
  not yield after freezing its reason"; 7310-7312 the fence "with no await in between") become
  methods that must stay synchronous. Each gets a comment and a test that asserts no microtask
  boundary (the S2 harness counts awaits).
- Dual representation during S3-S6 can disagree. The S2 agreement test runs in the unit lane, and
  each group's legacy maps are deleted in the PR that makes its slice authoritative, so at most one
  group is ever dual.
- Weak references: `ended` records must not extend a `Session`'s lifetime
  (`finalizedSessionIdentityRegistry` today). The GC seam test is in S6.
- `settled` promises can hide unhandled rejections; they resolve, never reject.
- W4 changes durability semantics. It is gated on `durable`; on Noop and after a failed append it
  keeps today's order, and W1 lands first. A bug in the `durable` signal is the worst case (a
  revived UUID), so the fault-injection test fails the signal itself.
- Multi-daemon rows: no SQL guard is removed in any step; the writer only removes in-process
  reordering, and W2 adds one guard. Peers read rows through the same statements.
- A writer that serializes per UUID makes a wedged write delay that UUID's next create row. It is
  bounded by the create deadline and affects only the UUID that was already wedged.
- Line count: S1 adds files, not lines, to `sessionManager.ts`; S3-S7 are net deletions. #11784
  must land first or nothing holds the gain.
- Unchanged and out of scope: derived-label maps, restore queues, per-device cleanup bookkeeping,
  the `Session` shape and the MCP surface.

## 8. Open decisions

1. Is one `fenced` state enough for the `forced`, `journal` and `peer-journal` sources, or must a
   forced terminal release stay distinguishable (#11361)? The design keeps `source` as a field so
   it can split later.
2. Should S8 (query/command split) be its own issue? It has the most callers and the least
   coupling to the rest.
3. W4 on Windows: the journal's directory fsync is skipped there (394-397). Decide whether
   `volatile` is the right answer on Windows or document the weaker guarantee.
