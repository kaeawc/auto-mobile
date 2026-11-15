# Session state record: row writer

Part of [the session state record](session-state-record.md).

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
  UPDATE. If the row does not exist yet, the writer upserts with the release status.
- Replacement applies to an **unwritten** desire only. An issued write occupies the
  slot until it settles or hits its deadline. After the deadline the next same-UUID write
  may issue while the old statement is parked. The writer still tracks the parked statement
  for late/refused callbacks, `settled` and `drain`. The writer never replaces a terminal desire
  with a non-terminal one unless the slot was lifted (`fenced` -> `creating`).
- Writer invariant: **an intent on disk implies the slot is `fenced`** (or `releasing`
  with `fence: "terminal"`). Startup replay has no generation guard, only "the row's
  reason is not terminal". Every path that replaces or refuses a durable terminal
  intent must therefore call `journal.resolve` synchronously with the transition. The paths
  are the `fenced` -> `creating` lift, a superseded fence, and a terminal write the generation
  guard refuses. Otherwise a restart would terminalize a newer incarnation of the same UUID.
- Cross-daemon safety keeps `expectedRowGeneration` and `unlessTerminal*` in SQL, plus a
  generation guard on terminal writes. Before classifying a generation advance as foreign, the release path awaits
  that incarnation's in-flight own row writes after reading the row (#12547), bounded
  by the persistence deadline; other incarnations stay protected by the guard.
- Terminal ordering: `desire(terminal)` is called synchronously after the final
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

## 6. Row writer implementation

SessionRowWriter owns the drain-write set, terminal retry scheduling and the
non-terminal snapshot map. Its adapter surface is `noteRelease`, `noteLive`,
`canIssueRelease` and `scheduleRetry`; in production `pending(uuid)` means only
"retry owed". Create/rebind upserts, activity and ownership
statements go through `upsertLive`, `recordLiveActivity`,
`replaceLiveOwnership` (pass-through, same await sequence). The
superseded-row state lives in `SessionRowWriter.superseded`
(`src/daemon/supersededRowReasserts.ts`), keyed off the writer's drain flag. It holds
remembered superseded reasons, release-reason predecessors, refused release writes,
pending-rewrite counts, rows under pending non-terminal releases, and owed rewrites with
backoff/timers/drain attempt. Row policy stays with the manager as per-entry callbacks
(`retry`, `retryDuringDrain`) so every read, statement and await keeps its order.

The per-UUID desire/settled/drain engine in `sessionRowWriter.ts` is test-exercised;
production first-attempt writes do not use it and stay manager-side. A past-deadline
write frees its slot in that engine. Production has no per-UUID serialization.

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
rejected-creation fence adoption and startup replay keep the terminal admission fence,
since resolving an intent must not make an ended UUID reusable. They cancel only the matching
snapshot without eagerly removing the manager retry entry. Actual lifts remove the
snapshot and cancel terminal desires and scheduled retries together. Plan-label minting
keeps its shadow probe and reason-state deletion between snapshot deletion and journal
resolution. Startup keeps recovered-intent/probe/adopted-owner deletion before
resolution. Retry-drop keeps cancel-retry and superseded bookkeeping before resolution.
A durable `record` clearing the volatile signal is not a fence lift. A non-terminal
commit also deletes the volatile intent, resolves the journal and cancels a terminal
retry (skipped when no terminal snapshot is fenced), and forced terminal snapshots
capture `expectedRowGeneration` and `releaseRowSessions`.

At most one unexpired standalone desire per UUID may issue; parked statements stay
tracked for callbacks and drain. Production bun:sqlite is synchronous, so the
overwrite regression parks injected statements and retry/precondition work around the
actual manager lift/publication. Fault tests use in-memory persistence and journal
files only. The synchronous journal fake models hang/delay as a whole-process pause: an
injected supervisor advances FakeTimer without firing JS callbacks, and an in-process
rebind cannot run inside it. Rejected journal syscalls yield the volatile result.
Persistence hang/delay suspends across FakeTimer turns. Crash cases discard the manager
and replay the committed disk prefix via `rehydratePersistedSessions`.
