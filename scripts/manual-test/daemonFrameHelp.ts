export const DAEMON_FRAME_COMMANDS = ["send", "session-info", "heartbeat"] as const;
export const DAEMON_FRAME_FLAGS: Record<string, string> = {
  "--socket": "Private absolute control socket (default: AUTOMOBILE_DAEMON_SOCKET_PATH).",
  "--type": "mcp_request or daemon_request (default: inferred from method).",
  "--count": "Number of first frames (default: 1).",
  "--timeout-ms": "Request/connect deadline in ms (default: 30000).",
  "--mode":
    "send, cancel, cancel-after:<ms>, cancel-keep-open[:<ms>] (default: send; read window: 5000).",
  "--cancel-after-ms": "Delay before same-connection cancellation in keep-open mode (default: 0).",
  "--broker-binding":
    "Bind a batch client name or acquire a standalone request.json on this connection.",
  "--token-of":
    "Use another batch client's token for status/release isolation frames only (never printed).",
  "--expect-refused":
    "Send guarded broker tools and require every response to be an error (send mode only).",
  "--hold-ms": "Keep the broker session alive after frames in send mode (default: 0).",
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
--broker-binding uses the product broker acquisition on the SAME connection as all frames.
A client name resolves through MT_BATCH to its unchanged request.json and owner-token;
its existing ready grant is kept on exit. A standalone request.json acquires a new grant,
keeps it alive with heartbeats and releases it on graceful exit (it can create/boot devices).
Params strings support {{ownSessionId}}, {{clientSessionId:<name>}} and
{{ownLivenessOwnerToken}}; unresolved values refuse before connecting. Indexed ownSessionId
placeholders were removed; use {{clientSessionId:<name>}} for cross-client isolation.
Broker bindings refuse startDevice/provisionDevice/getAndroid/getApple/killDevice locally;
--expect-refused sends them to prove the product gate rejects them (success exits 2).
Broker bindings always refuse resources/list and read automobile:devices/* and --allow-selector.
--token-of must name another client of the same batch and only applies to user
sessionRequestStatus/releaseBrokerSession frames; binding/heartbeats keep the binding owner's token.
A one-line isolation notice names the client; owner tokens are redacted from output.
Cancel/cancel-after destroy the socket; a standalone grant ends through owner loss.
Cancel-keep-open sends daemon/cancelRequest for each id and prints answers plus a cancelled summary.
Exit codes: 0 expected responses/cancel ran, 1 typed refusal, 2 usage/guard or expected-refusal mismatch, 3 timeout/connection error.
Examples (source the private env through the generated wrappers):
  <batch>/bin/frame1 session-info SESSION
  <batch>/bin/frame1 heartbeat SESSION --count 1
  <batch>/bin/frame1 send daemon/session-info '{"sessionId":"SESSION"}'
  <batch>/bin/frame1 send tools/call @params.json --mode cancel-keep-open:5000 --cancel-after-ms 100
  <batch>/bin/frame1 send tools/call '{"name":"observe","arguments":{"sessionUuid":"{{clientSessionId:b}}"}}' --broker-binding a
  <batch>/bin/frame1 send tools/call '{"name":"startDevice","arguments":{}}' --broker-binding a --expect-refused
  <batch>/bin/frame1 send daemon/releaseBrokerSession '{"sessionId":"{{ownSessionId}}"}' --broker-binding a --token-of b --expect-refused`;
}
