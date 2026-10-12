export const AUX_SOCKET_COMMANDS = ["recording", "video", "webrtc"] as const;
export const AUX_SOCKET_ACTIONS = {
  recording: ["start", "stop", "status"],
  webrtc: ["start", "stop", "status", "list", "await"],
} as const;
export const AUX_SOCKET_FLAGS: Record<string, { kinds: readonly string[]; meaning: string }> = {
  "--session-uuid": {
    kinds: AUX_SOCKET_COMMANDS,
    meaning: "Device/session UUID (default: none; required for recording).",
  },
  "--observer": {
    kinds: ["video", "webrtc"],
    meaning: "Register a viewing observer (default: off; never recording).",
  },
  "--observer-name": {
    kinds: AUX_SOCKET_COMMANDS,
    meaning: "Observer client name (default: manual-test-observer).",
  },
  "--heartbeat-ms": {
    kinds: AUX_SOCKET_COMMANDS,
    meaning: "Observer cadence below its lease (default: 2000).",
  },
  "--device-id": { kinds: ["recording"], meaning: "Recording target device (default: omitted)." },
  "--platform": { kinds: ["recording"], meaning: "android or ios (default: omitted)." },
  "--recording-id": { kinds: ["recording"], meaning: "Recording to stop (default: omitted)." },
  "--plan-name": { kinds: ["recording"], meaning: "Recording plan name (default: omitted)." },
  "--hold-ms": { kinds: ["video"], meaning: "Video read window after ack (default: 5000)." },
  "--timeout-ms": {
    kinds: ["webrtc"],
    meaning: "WebRTC deadline (default: 45000; recording/video also use 45000).",
  },
  "--help": {
    kinds: AUX_SOCKET_COMMANDS,
    meaning: "Show stdout usage; also -h, help or <command> --help (default: execute).",
  },
};
export const RECORDING_SESSION_GUIDANCE =
  "Recording needs --session-uuid: a device session (the owner for start/stop; any live device session may read status). Get sessionUuid from proxy-session.ts up/status or amN daemon active-sessions --json. --observer is for video/WebRTC viewers only.";
export function auxSocketHelp(): string {
  return `Usage: aux-socket <command> [options]
Commands:
  recording <start|stop|status>  Use device-gesture-recording.sock with a device session.
  video '<subscribe json>'      Subscribe and count bytes; no exported packet decoder.
  webrtc <start|stop|status|list|await> ['<request json>']  start needs whipEndpoint.
Requires the private harness env. Observers register, heartbeat and release on its control socket.
${RECORDING_SESSION_GUIDANCE}
Options:
${Object.entries(AUX_SOCKET_FLAGS)
  .map(([flag, row]) => `  ${flag} (${row.kinds.join("/")})  ${row.meaning}`)
  .join("\n")}
Exit codes: 0 success, 1 typed refusal, 2 usage/guard, 3 timeout/connection error.
Examples:
  <batch>/bin/aux1 recording status --session-uuid SESSION
  <batch>/bin/aux1 recording start --device-id DEVICE --platform android --plan-name manual --session-uuid SESSION
  <batch>/bin/aux1 recording stop --recording-id RECORDING --session-uuid SESSION
  <batch>/bin/aux1 video '{"action":"subscribe","deviceId":"DEVICE","platform":"android"}' --observer
  <batch>/bin/aux1 webrtc list --observer`;
}
