# Liveness behaviour mutants and the scenario rows that kill them (#11444, #10655, #11357)

The pass-5 mutation sweep names 31 behaviour mutants. Every one should be killed by at least one
matrix, wire or seeded scenario row; a narrow unit test may also kill it but does not count. This
file is the per-mutant killer list so the next sweep can diff against it. The mutants that
`#11444` listed as killed only by narrow tests are below; rows are in
`test/daemon/livenessScenarioMatrix.test.ts` unless a file is named.

| Mutant    | Behaviour                                                     | Scenario row that kills it                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| e         | recording finalize not capped                                 | matrix: "an idle release while a recording finalize hangs frees the device at the cap, and the recording is marked incomplete"                                                                                          |
| f         | `start()` does not subscribe tool-end activity                | NOT killed by a scenario row: the matrix harness runs `subscribeToolCallEndActivity` itself by its production name, so only `daemonStartWiring.test.ts` pins it. Needs a harness that drives `Daemon.start()` (#11441). |
| g         | terminal write never retried (#10959)                         | matrix: "a crash after a terminal release intent" (the release whose database write never landed is still refused after the restart)                                                                                    |
| i         | proxy refuses reads after release (#10971)                    | matrix: "a read through the proxy after an idle release succeeds without a session, and binds nothing"                                                                                                                  |
| j1        | readiness runs before a refusal when no deviceId is given     | matrix: "a refused call naming no deviceId touches no readiness and never drives the device"                                                                                                                            |
| l         | `sqlQuery` write classified as a read                         | matrix: "a non-owner's write SQL on a held device is refused before readiness"; seeded: `sqlWrite` / `sqlRead` steps (`poolOwnershipConcurrency.slotsAndTools.property.test.ts`)                                        |
| m1, m2    | `ide/*` mutation skips ownership                              | matrix: "a non-owner's ide/setKeyValue is refused and never reaches the device"; seeded: `ideMutation` step                                                                                                             |
| n, K2, K3 | desktop input without claiming the device; raw provider       | NOT in this file: wire replay rows (desktop wire contract issue); Kotlin narrow tests                                                                                                                                   |
| o1        | appearance socket applies to devices the session does not own | matrix: "a non-holder's appearance set does not touch the device"                                                                                                                                                       |
| p         | idle release not terminal (reverting #11258)                  | matrix: "the agent's next call naming the released session is refused and the device stays idle" (also before and after a restart), and the control-call refusal in the #10971 read row                                 |
| q         | managed-slot device taken by generic allocation               | seeded: `slotAssign` / `slotExecStart` / `slotExecEnd` / `slotRelease` steps with the `slot-device-allocated-generically` invariant                                                                                     |
| s1, s2    | late ack does not cancel the handover                         | matrix: "a daemon stall followed by a late ack inside the recovery budget recovers the session instead of handing it over", and its counterpart with no ack                                                             |

## Seeded harness invariants (pool level)

`poolOwnershipConcurrency.slotsAndTools.property.test.ts` runs the `slots`, `tools` and
`slotsAndTools` profiles with `managedSlots: true`; after every step the harness checks, on top of
the ownership invariants:

- `non-owner-control-ran`: no non-owner control (`tapOn`, `ide/*` mutation, write SQL) ever runs a
  handler. A slot device is judged once its slot is older than the one-second admission snapshot.
- `slot-device-allocated-generically`: no generic session is created on a device a slot holds.
- `tool-read-stamped-activity`: a read, with or without a session, never moves an idle clock.
- `slot-execution-refused`: a slot's own execution is never refused its device.
