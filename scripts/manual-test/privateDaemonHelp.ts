import { PRODUCT_PATH_ENV_VARIABLES } from "./productPathEnv";
export const PRIVATE_DAEMON_COMMANDS = [
  "init",
  "start",
  "stop",
  "status",
  "env",
  "wrappers",
] as const;
export const PRIVATE_DAEMON_FLAGS: Record<string, string> = {
  "--batch-dir": "Absolute evidence root (required).",
  "--count": "Number of daemons, 1–8 (required for init).",
  "--base-port": "First HTTP port (required for init); consecutive ports follow.",
  "--aux-root": "Short absolute socket root (default: /tmp/am-mt-<batch hash>).",
  "--server": "Absolute built server path (default: checkout/dist/src/index.js).",
  "--orphan-idle-ms": "Orphan idle timeout (default: 0, disabled).",
  "--env": "Repeatable K=V for all daemons (default: none).",
  "--daemon-env": "Repeatable N:K=V for daemon N; overrides --env (default: none).",
  "--daemon-arg": "Repeatable verbatim token or N:token; also --daemon-arg=token (default: none).",
  "--split-adb-coordination": "Separate ADB coordination (default: batch shared/adb-servers).",
  "--daemon": "Select daemon N (default: all; required for stop/env).",
  "--devices":
    "Append inventories using daemon/availableDevices, refreshing ownership and discovery (default: off).",
  "--": "Append one-off daemon argv to start (default: none).",
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
  wrappers  Regenerate only <batch>/bin/amN, proxyN, frameN, auxN.
Options (init uses count through split; read commands use batch-dir/daemon):
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
Examples:
  private-daemon init --batch-dir /private/batch --count 2 --base-port 3160 --daemon-arg --plan-execution-lock-scope --daemon-arg session --daemon-arg --tool-call-recording --daemon-env 2:AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA=/private/prebuilt
  private-daemon stop --batch-dir /private/batch --daemon 2
  private-daemon start --batch-dir /private/batch --daemon 2 -- --debug
  private-daemon status --batch-dir /private/batch --devices
  /private/batch/bin/am1 cli listDevices`;
}
