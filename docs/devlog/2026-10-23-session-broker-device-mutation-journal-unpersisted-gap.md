# Unpersisted recording gap is an accepted residual

- Kind: decision
- Date: 2026-10-23
- Source: moved from `how-it-works/session-broker-device-mutation-journal.md`; #15147, #15160
- Shaped: [Device mutation journal and baseline reset contract](../how-it-works/session-broker-device-mutation-journal.md)

## Context

When a broker session's journal recording fails, the daemon marks the session's recording gap in
memory so its next keep-booted reset falls back. That mark is keyed by session UUID and is lost on
daemon restart.

## Options

- Persist the gap as a marker table in the SQLite registry the journal uses.
- Leave the gap in memory.

## Decision

Leave the gap in memory (ACCEPTED-RESIDUAL).

## Consequences

- A marker table would fail with an unwritable journal, the same case that creates a gap, and would
  need a registry migration, advancing the schema boundary older daemons refuse.
- The best-effort `recording-failed` fallback row already survives restart when the journal is
  writable, and Android loses its in-memory baseline on restart and already fails closed.
- The residual is an iOS session whose journal was unwritable and whose daemon restarted before
  reset.
