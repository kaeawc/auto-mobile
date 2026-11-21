# Fixture capture mode

- Kind: decision
- Date: 2026-11-20
- Source: #18770 (epic #18769), PR #18834, follow-up #18881
- Shaped: [Fixture capture mode](../how-it-works/fixture-capture.md)

## Context

Parser and contract fixtures under `test/fixtures/` were captured by hand. They went stale, or
someone rebuilt them from AOSP or Apple sources instead of real device output (see #18769).

Issue #18770 asked for an opt-in mode in which the tools record the commands they run on a device,
with provenance. A second step copies a chosen output into the tree.

## Options

PR #18834 records these choices where the issue left them open:

- Recording seam: reuse `runExecSeam`, the exec path the Android and Apple command runners already
  share, rather than add a new executor path.
- Form-factor directories: the device model's `FormFactor` values (`phone`, `tablet`, `foldable`,
  `tv`, `watch`, `automotive`, `xr-headset`, `xr-glasses`) rather than the issue's
  `wear`/`xr`/`vision`.
- Fixture format: `.txt` only, because oxfmt would rewrite JSON or Markdown captures.
- Write timing: one capture directory per tool call, written when the call settles.

Review of PR #18834 (#18881) found two size-limit cases. A command that overflows node's
`maxBuffer` returns partial output that can be exactly the stream limit. Concurrent commands also
spent the shared per-call budget in completion order. For the second, the options were to reserve
budget in issue order when a command starts, or to apply it after sorting by index when the capture
is written.

## Decision

- Capture is off unless `AUTOMOBILE_CAPTURE_FIXTURES_DIR` is set; with it unset no scope exists and
  nothing is recorded or written.
- `ToolRegistry` opens one AsyncLocalStorage scope per tool call; each command belongs to the
  innermost call that issued it.
- Nothing is redacted at capture time except password-field input (owner policy); redacted commands
  cannot be promoted.
- Promotion requires a clean source-checkout commit, a device with an OS version or API level and a
  matching form factor, and a command that is neither redacted nor truncated.
- A `maxBuffer` overflow (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) marks the command `truncated`.
- The scope cuts each stream at the per-stream limit when its command finishes. It applies the
  per-call budget in issue order when it writes the capture, since output length is unknown when a
  command starts.

## Consequences

- A change to the on-disk format bumps `FIXTURE_CAPTURE_SCHEMA_VERSION`; the promote step accepts
  only the current version.
- A scope holds at most the per-stream limit for each stream of each command until it is written.
- Which command of a call loses output to the call limit depends only on issue order.
- Spawned and streaming processes, CtrlProxy and XCTestRunner frames are not captured yet.
