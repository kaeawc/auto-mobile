export const DAEMON_FRAME_COMMANDS = ["send", "session-info", "heartbeat"] as const;
export const DAEMON_FRAME_FLAGS: Record<string, string> = {
  "--socket": "Private absolute control socket (default: AUTOMOBILE_DAEMON_SOCKET_PATH).",
  "--type": "mcp_request or daemon_request (default: inferred from method).",
  "--count": "Number of first frames (default: 1).",
  "--timeout-ms": "Request/connect deadline in ms (default: 30000).",
  "--mode":
    "send, cancel, cancel-after:<ms>, cancel-keep-open[:<ms>] (default: send; read window: 5000).",
  "--cancel-after-ms": "Delay before same-connection cancellation in keep-open mode (default: 0).",
  "--managed-binding":
    "Acquire real slots from JSON or a config path on this connection (default: none).",
  "--hold-ms": "Keep managed sessions alive after frames in send mode (default: 0).",
  "--then":
    "Repeatable '<method> <params json|@file>' sent sequentially after first answers (default: none; send mode only).",
  "--allow-selector": "Permit selector-only device acquisition (default: refused).",
  "--allow-host-mutation": "Permit IDE restart/maintenance frames (default: refused).",
  "--help": "Show usage on stdout; also -h, help or <command> --help (default: execute).",
};
export function daemonFrameHelp(): string {
  return `Usage: daemon-frame <command> [options]
Commands:
  send <method> ['<params json>'|@file]  Send exactly the method requested.
  session-info <sessionId>             Send daemon/sessionInfo.
  heartbeat <sessionId>                Send the external CLI keeper heartbeat without claiming ownership.
A heartbeat for a proxy-owned session is rejected by the daemon and changes nothing.
Options:
${Object.entries(DAEMON_FRAME_FLAGS)
  .map(([flag, meaning]) => `  ${flag}  ${meaning}`)
  .join("\n")}
--managed-binding ACQUIRES real slots and can create/boot amslot-* devices.
Use a runner namespace no live proxy is using. All frames use that SAME connection.
Params strings support {{ownSessionId}}, {{ownSessionId:<slotIndex>}} and
{{ownLivenessOwnerToken}} only with --managed-binding; unresolved values refuse before user frames.
Cancel/cancel-after destroy the socket; managed sessions end through owner loss.
Cancel-keep-open sends daemon/cancelRequest for each id and prints answers plus a cancelled summary.
Exit codes: 0 all frames succeeded/cancel ran, 1 typed refusal, 2 usage/guard, 3 timeout/connection error.
Examples (source the private env through the generated wrappers):
  <batch>/bin/frame1 session-info SESSION
  <batch>/bin/frame1 heartbeat SESSION --count 1
  <batch>/bin/frame1 send daemon/session-info '{"sessionId":"SESSION"}'
  <batch>/bin/frame1 send tools/call @params.json --mode cancel-keep-open:5000 --cancel-after-ms 100
  <batch>/bin/frame1 send ide/status '{}' --managed-binding configs/slot.json --then 'daemon/sessionInfo {"sessionId":"{{ownSessionId}}"}' --then 'daemon/releaseExecution {"sessionId":"{{ownSessionId}}","livenessOwnerToken":"{{ownLivenessOwnerToken}}"}'`;
}
