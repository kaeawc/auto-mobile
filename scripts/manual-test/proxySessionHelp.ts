export const PROXY_SESSION_COMMANDS = [
  "up",
  "serve",
  "call",
  "read",
  "tools",
  "resources",
  "subscribe",
  "status",
  "close",
  "release",
  "abandon",
  "info",
  "owner-kill",
] as const;
export const PROXY_SESSION_FLAGS: Record<string, { ops: readonly string[]; meaning: string }> = {
  "--dir": {
    ops: PROXY_SESSION_COMMANDS,
    meaning: "Plain-proxy evidence directory (NEW for up/serve); exclusive with --client.",
  },
  "--client": {
    ops: PROXY_SESSION_COMMANDS,
    meaning: "Batch client name from MT_BATCH/broker/clients.json.",
  },
  "--as-client": {
    ops: ["release", "abandon"],
    meaning: "Isolation tests only: use another batch client's stored token; prints a notice.",
  },
  "--resume": { ops: ["up"], meaning: "Replay the same request.json and owner-token bytes." },
  "--profile": {
    ops: ["up", "serve"],
    meaning:
      "One-off hardware archetype name or inline device requirement JSON; exclusive with --request.",
  },
  "--request": {
    ops: ["up", "serve"],
    meaning: "SessionConfig inline JSON or file path; fresh batch attempt ID assigned.",
  },
  "--expect": {
    ops: ["up"],
    meaning: "ready or failed:<code>: expected outcome exits 0; mismatch exits 2.",
  },
  "--owner": {
    ops: ["up", "serve"],
    meaning: "driver (default) or disposable (harness-owned sleep process).",
  },
  "--allow-foreign-session": {
    ops: ["call"],
    meaning: "Allow explicit selectors for another named ready client in this batch.",
  },
  "--all": { ops: ["status"], meaning: "Print a status table for every batch client." },
  "--env": {
    ops: ["up", "serve"],
    meaning: "Repeatable K=V child environment override (default: none; private paths guarded).",
  },
  "--init-timeout-ms": {
    ops: ["up", "serve"],
    meaning: "Initialize deadline in ms (default: 900000).",
  },
  "--timeout-ms": { ops: ["call"], meaning: "Tool deadline in ms (default: 900000)." },
  "--full": {
    ops: ["call", "read", "tools", "resources", "subscribe", "close"],
    meaning: "Print full response envelope (default: compact).",
  },
  "--allow-selector": {
    ops: ["call"],
    meaning: "Plain --dir only: permit selector-only device acquisition (default: refused).",
  },
  "--help": {
    ops: PROXY_SESSION_COMMANDS,
    meaning: "Show stdout usage; also -h, help or <command> --help (default: execute).",
  },
};
export function proxySessionHelp(): string {
  return `Usage: proxy-session <command> (--client N | --dir D) [options]
Commands:
  up                       Spawn the persistent driver and wait for initialize.
  serve                    Run the persistent driver as the proxy's parent.
  call <tool> [json|@file]  Publish a tool request and await its evidence.
  read <uri>               Read a resource.
  tools                    List tools.
  resources                List resources and templates.
  subscribe <uri>          Subscribe; notifications stay in notifications.jsonl.
  status                   Report session outcome, grant/profile/failure, owner liveness and daemonSocketAlive; --all prints all clients.
  close                    Close cleanly; wait up to 240 s for a released broker receipt.
  release                  Release the granted session with the stored token; wait for cleanup (240 s).
  abandon                  Abandon the stored request, including unknown requests (240 s).
  info                     Save the grant's current native device descriptor to info.json.
  owner-kill               Signal only the recorded disposable owner after start-identity confirmation.
release/abandon/info/owner-kill require --client; tokens are always read from owner-token.
up/serve require BOTH a live private daemon pid and an answering control socket; start the private daemon first.
Broker sessionUuid/profile are in init.json.session printed by up and status.
Broker calls require a ready grant and live driver. Broker clients refuse resources, device inventory reads, startDevice/provisionDevice/getAndroid/getApple/killDevice, and --allow-selector.
Fresh up archives prior evidence; --resume preserves request/token bytes. Tokens are redacted.
Pending/failed sessions never fall back to device acquisition; typed failure codes are printed.
Options:
${Object.entries(PROXY_SESSION_FLAGS)
  .map(([flag, row]) => `  ${flag} (${row.ops.join("/")})  ${row.meaning}`)
  .join("\n")}
Exit codes: 0 success/status, 1 refused/failed response, 2 usage/guard/wait deadline,
3 serve transport closed, 4 serve initialize failed.
Examples:
  <batch>/bin/proxy1 up --client a-phone
  <batch>/bin/proxy1 up --client a-phone --resume --expect failed:capacity_exhausted
  <batch>/bin/proxy1 call --client a-phone observe '{}'
  <batch>/bin/proxy1 status --all
  <batch>/bin/proxy1 up --dir /private/batch/sessions/plain
  <batch>/bin/proxy1 call --dir /private/batch/sessions/plain startDevice '{"platform":"android","avdName":"manual-test-avd"}'
  <batch>/bin/proxy1 read --dir /private/batch/sessions/plain automobile:devices/booted
  <batch>/bin/proxy1 status --dir /private/batch/sessions/plain
  <batch>/bin/proxy1 close --dir /private/batch/sessions/plain`;
}
