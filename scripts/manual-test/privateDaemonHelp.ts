import { PRODUCT_PATH_ENV_VARIABLES } from "./productPathEnv";
export const PRIVATE_DAEMON_COMMANDS = [
  "init",
  "start",
  "stop",
  "status",
  "env",
  "wrappers",
  "devices",
  "shutdown-devices",
  "preflight",
  "boot-gate",
] as const;
export const PRIVATE_DAEMON_FLAGS: Record<string, string> = {
  "--batch-dir": "Absolute evidence root (required).",
  "--count": "Number of daemons, 1–8 (required for init).",
  "--base-port": "First HTTP port (required for init); consecutive ports follow.",
  "--broker-batch": "Broker batch JSON input for init; daemon 1 is the only broker.",
  "--max-devices": "Broker total-device ceiling (default: 2; hard maximum: 4).",
  "--allow-reuse":
    "Allow clean-device reuse and a nonzero idle pool for broker init (default: off).",
  "--aux-root": "Short absolute socket root (default: /tmp/am-mt-<batch hash>).",
  "--server": "Absolute built server path (default: checkout/dist/src/index.js).",
  "--orphan-idle-ms": "Orphan idle timeout (default: 0, disabled).",
  "--env": "Repeatable K=V for all daemons (default: none).",
  "--daemon-env": "Repeatable N:K=V for daemon N; overrides --env (default: none).",
  "--daemon-arg": "Repeatable verbatim token or N:token; also --daemon-arg=token (default: none).",
  "--split-adb-coordination": "Separate ADB coordination (default: batch shared/adb-servers).",
  "--daemon": "Select daemon N (default: all; required for stop/env).",
  "--protect": "Repeatable protected AVD/simulator name or serial/UDID for init (default: none).",
  "--wait-ms": "Stop wait bound, integer >= 0 (default: 30000 ms).",
  "--device":
    "Repeatable shutdown target by device ID or unique name; checked batch-inferred devices require exact device ID (serial/UDID); an ambiguous selector stops nothing (ambiguous) (default: only batch-booted unprotected virtual devices with positive environment evidence).",
  "--dry-run":
    "Plan init files/modes/start env without writes or probes, or list shutdown outcomes (default: off).",
  "--strict": "Preflight exits 1 when warnings are present (default: off).",
  "--role": "Boot role matching ^[A-Za-z0-9._-]{1,64}$ (required for boot-gate; no default).",
  "--max-concurrent": "Boot permits, integer 1–8 (default: 1).",
  "--max-load": "Positive 1-minute load threshold (default: 2 * host CPU count).",
  "--min-interval-ms": "Minimum interval between boot grants, integer >= 0 (default: 30000 ms).",
  "--poll-ms": "Boot-gate polling interval, positive integer (default: 2000 ms).",
  "--timeout-ms":
    "Wait/request bound (default: devices 30000 ms; shutdown-devices 60000 ms; boot-gate 600000 ms).",
  "--devices":
    "Append inventories using daemon/availableDevices, refreshing ownership and discovery (default: off).",
  "--ledger": "Read devices ledger evidence only; no socket or host probes (devices only).",
  "--": "Append one-off daemon argv to start or a command to boot-gate (default: none; boot-gate requires a command after --).",
  "--help": "Show this help, also -h or help (default: run command).",
};
export function privateDaemonHelp(): string {
  return `Usage: private-daemon <command> [options]
Commands:
  init      Create a new private batch, env files and executable wrappers.
  start     Start selected/all daemons using recorded args plus -- extras.
  stop      Stop one isolated daemon and remove its pid.txt on success.
  status    Read selected/all pid/socket state; --devices adds inventories.
  env       Print one daemon's env.sh path.
  wrappers  Regenerate <batch>/bin/amN, proxyN, frameN, auxN, brokerN (brokerN always uses daemon 1).
  devices   List merged daemon device views with provenance, protection and PID.
  shutdown-devices  Stop only batch-booted unprotected virtual devices through a daemon.
  preflight  Report host power, sleep, lid, load and memory without requiring batch.json.
  boot-gate  Stagger device boots using shared permits, host load and a minimum interval.
Options (flags are accepted only by their applicable command):
${Object.entries(PRIVATE_DAEMON_FLAGS)
  .map(([flag, meaning]) => `  ${flag}  ${meaning}`)
  .join("\n")}
Derived state env (existing namespace paths are harness-owned; new defaults may be privately overridden):
${PRODUCT_PATH_ENV_VARIABLES.filter((row) => row.kind === "state")
  .map((row) => `  ${row.name} (${row.owner ?? "default"}, ${row.scope})`)
  .join("\n")}
Opt-in paths (unset by default; inherited values stripped; --env/--daemon-env require private absolute paths):
${PRODUCT_PATH_ENV_VARIABLES.filter((row) => row.kind === "opt-in")
  .map((row) => `  ${row.name}`)
  .join("\n")}
Android inventory reads the local ADB server socket without launching adb; it can neither start nor restart a server.
Other derived env: MT_BATCH, MT_DAEMON, MT_SERVER, MT_PORT; AUTOMOBILE_APPEARANCE_SYNC=off; AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS=0 unless configured.
Broker init renders broker/host-config.json and broker/clients.json (0600). AUTOMOBILE_SESSION_BROKER_CONFIG is set only for daemon 1 start; client/wrapper env stays scrubbed. --env/--daemon-env cannot set broker/session configuration variables.
Devices and teardown:
  batch-booted: positive MT_BATCH evidence for this batch; bootedBy daemon<N> comes from MT_DAEMON=P<digits>.
  broker-owned: product naming predicate matches; display only, never authorizes shutdown.
  Broker batches additionally classify allowed/foreign/protected using ready batch grants and session-info native identities in evidence/ledger.jsonl. Allowed rows include client and sessionUuid; protected always wins. devices --ledger reads that evidence without any probes.
  foreign: process environment read without this batch's marker, regardless of baseline.
  preexisting: no process evidence and ID in baseline; batch-inferred: no process evidence and ID absent from a recorded baseline (every iOS simulator).
  unknown: baseline missing/unavailable without process evidence, or conflicting daemon rows; never stopped.
  Evidence is the MT_BATCH/MT_DAEMON environment inherited by an emulator from the private daemon, read with ps eww for the one PID lsof resolved. It has not yet been observed on a live batch.
  Rows include provenance, optional bootedBy and processAvdName (-avd argument); seenByDaemons is visibility, not boot ownership.
  Protection checks deviceId, name, identity.stableId and processAvdName; unreadable/Unknown (<serial>) names without an AVD name are protected when the protected list is nonempty.
  Default targets have positive evidence only; check batch-inferred devices and name them by exact device ID (serial/UDID) with --device. An ambiguous selector stops nothing (ambiguous); a separate unambiguous selector still applies. foreign/preexisting/unknown are refused even when named.
  Outcomes: stopped (including device_already_stopped, retaining its message), refused (product code/message), failed/timeout (transport), protected, not-batch-booted, inferred-not-stopped (check and name by device ID with --device), ambiguous (multiple matches; name by device ID), held-by-other-daemon (no frame), broker-held (no frame), not-found, dry-run, daemon-dead (snapshot evidence only).
  broker-held targets (any heldBy value) are refused before sending a stop frame; the harness never signals a device process or passes force.
  Inventory refusal, malformed payload or transport failure produces daemonErrors [{name,error}]; shutdown exits 1 while still stopping healthy targets. devices exits 1 only when no daemon produced an inventory. A socket reply is alive even when unparseable.
  Without inventories, fallback reports unprotected batch-booted/batch-inferred snapshot devices, honors selectors including ambiguity and explicit refusals, and sends nothing.
stop --wait-ms 0 signals and reports still-alive unless the daemon is already gone.
boot-gate --min-interval-ms is best-effort when --max-concurrent is above 1. A boot-gate killed by a signal leaves its permit lock to be reclaimed once its PID is gone.
Exit codes: 0 success/status; 1 typed non-success outcome (daemon still alive, a device not stopped, inventory errors, preflight --strict with warnings); 2 usage/guard/I/O or a boot-gate wait deadline; start propagates the product launch command's exit code; boot-gate -- COMMAND exits with the command's code.
Examples:
  private-daemon init --batch-dir /private/batch --count 2 --base-port 3160 --broker-batch /private/broker-batch.json --dry-run
  private-daemon init --batch-dir /private/batch --count 2 --base-port 3160 --daemon-arg --plan-execution-lock-scope --daemon-arg session --daemon-arg --tool-call-recording --daemon-env 2:AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA=/private/prebuilt
  private-daemon stop --batch-dir /private/batch --daemon 2
  private-daemon start --batch-dir /private/batch --daemon 2 -- --debug
  private-daemon status --batch-dir /private/batch --devices
  private-daemon devices --batch-dir /private/batch
  private-daemon shutdown-devices --batch-dir /private/batch --device emulator-5556 --dry-run
  private-daemon preflight --batch-dir /private/batch --strict
  private-daemon boot-gate --batch-dir /private/batch --role A1 -- /private/batch/bin/proxy1 call --dir /private/batch/sessions/a1 startDevice '{"platform":"android","avdName":"manual-test-avd"}'
  /private/batch/bin/am1 cli listDevices`;
}
