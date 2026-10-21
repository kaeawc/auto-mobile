export class DaemonShutdownState {
  inProgress = false;

  /** Session IDs whose normal callback emitted the daemon-shutdown reason. */
  releaseNotifications: Set<string> | null = null;

  /** Session IDs emitted by the shutdown fallback before their normal callback completed. */
  fallbackReleaseNotifications: Set<string> | null = null;
}
