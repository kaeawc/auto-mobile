/**
 * Daemon commands that launch a daemon process. They configure it with the caller's tool profile
 * and startup options, so they run after the server bootstrap in `src/index.ts`.
 */
const DAEMON_LAUNCH_COMMANDS: ReadonlySet<string> = new Set([
  "start",
  "restart",
  "restart-admitted",
  "restart-acceptance-session",
]);

/**
 * Whether a `--daemon <command>` invocation returns before the server bootstrap (#11252): every
 * command that only talks to an existing daemon (status, stop, health, diagnose, heartbeat,
 * available-devices, active-sessions, session-info, release-session,
 * release-liveness-ownership) and any unknown command, which only prints usage. The bootstrap
 * registers MCP tools and kicks off startup maintenance (iOS orphan-runner reaping) and the
 * CtrlProxy APK, xcodebuild and video-jar prefetches, none of which a one-shot query needs.
 */
export function daemonCommandSkipsServerBootstrap(command: string): boolean {
  return !DAEMON_LAUNCH_COMMANDS.has(command);
}
