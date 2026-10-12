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
] as const;
export const PROXY_SESSION_FLAGS: Record<string, { ops: readonly string[]; meaning: string }> = {
  "--dir": {
    ops: PROXY_SESSION_COMMANDS,
    meaning: "Session evidence directory (required; NEW for up/serve).",
  },
  "--config": {
    ops: ["up", "serve"],
    meaning: "Managed-slot JSON or config path (default: plain proxy).",
  },
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
    meaning: "Permit selector-only device acquisition (default: refused).",
  },
  "--help": {
    ops: PROXY_SESSION_COMMANDS,
    meaning: "Show stdout usage; also -h, help or <command> --help (default: execute).",
  },
};
export function proxySessionHelp(): string {
  return `Usage: proxy-session <command> --dir D [options]
Commands:
  up                       Spawn the persistent driver and wait for initialize.
  serve                    Run the persistent driver as the proxy's parent.
  call <tool> [json|@file]  Publish a tool request and await its evidence.
  read <uri>               Read a resource.
  tools                    List tools.
  resources                List resources and templates.
  subscribe <uri>          Subscribe; notifications stay in notifications.jsonl.
  status                   Report proxy/driver pids, init, closed and daemonSocketAlive.
  close                    Close the proxy cleanly and release its execution.
up/serve require BOTH a live private daemon pid and an answering control socket; start the private daemon first.
Device sessionUuid is in the tool response/managedSlots printed by up and status.
Options:
${Object.entries(PROXY_SESSION_FLAGS)
  .map(([flag, row]) => `  ${flag} (${row.ops.join("/")})  ${row.meaning}`)
  .join("\n")}
Exit codes: 0 success/status, 1 refused/failed response, 2 usage/guard/wait deadline,
3 serve transport closed, 4 serve initialize failed.
Examples:
  <batch>/bin/proxy1 up --dir /private/batch/sessions/plain
  <batch>/bin/proxy1 call --dir /private/batch/sessions/plain startDevice '{"platform":"android","avdName":"manual-test-avd"}'
  <batch>/bin/proxy1 read --dir /private/batch/sessions/plain automobile:devices/booted
  <batch>/bin/proxy1 status --dir /private/batch/sessions/plain
  <batch>/bin/proxy1 close --dir /private/batch/sessions/plain`;
}
