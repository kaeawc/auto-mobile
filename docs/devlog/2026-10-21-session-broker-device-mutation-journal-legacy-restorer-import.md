# Legacy-restorer import into the mutation journal

- Kind: idea
- Date: 2026-10-21
- Source: moved from `how-it-works/session-broker-device-mutation-journal.md`; #14677, #15053
- Shaped: [Device mutation journal and baseline reset contract](../how-it-works/session-broker-device-mutation-journal.md)

## Deferred

Importing legacy restorers into the journal (AC3) was deferred. Shared `device` keys hold
incompatible values (tool clock priors `{ instant, automaticTime }` vs `ClockSessionState`
`{ initialAutomaticTime, clockChangedByUs, rootedByUs }`; tool network priors
`values ?? observedValues ?? profile` vs `{ initialProfile, iosAppRule }`), which would fail the
deep-equality check, and a captured clock instant ages before restore. Normalization and
clock-restore semantics must be resolved first.

Retirement pruning of baselines, journals and per-session recorder rows was left as follow-up:
there was no fenced native retirement owner.
