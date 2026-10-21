export function brokerBatchHelp(): string {
  return `Usage: broker<N> up [--clients a,b | --all] [--stagger-ms N] [--max-devices N]
       broker<N> status | down | report

Run through <batch>/bin/broker1 (MT_BATCH identifies the private batch).
up defaults to all clients. Re-runs private-daemon preflight --strict and requires
an alive session-broker/v1 control socket before launching anything. --max-devices
defaults to 2, with a hard ceiling of 4; it must cover totalDeviceCap.
Every acquisition holds a boot-gate permit until proxy up finishes. The existing
boot-gate load limit (2 * CPU count) and minimum interval (30000ms) apply.
Planned ready clients finish before expected capacity_exhausted refusals launch.
--stagger-ms defaults to 0 and spaces client starts in addition to the boot gate.
status uses proxy-session status --all. down closes clients in reverse start
order, waits for release receipts and verifies native absence (240s budget).
report writes evidence/broker-report.json with outcomes, timings and ledger data.
Acquisitions have a 26-minute deadline including the boot gate; timeout does not
signal processes. Inspect status and run down before starting another batch.`;
}
