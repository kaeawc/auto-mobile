import { Daemon } from "../../../src/daemon/daemon";

/**
 * A real `Daemon` whose start/stop wiring is reachable through named test seams, so a test can run
 * the daemon's production subscriptions and teardown without starting sockets or device discovery.
 */
export class DaemonLifecycleHarness extends Daemon {
  /** The subscription `start()` makes to tool-call ends. */
  subscribeToolCallEnd(): void {
    this.subscribeToolCallEndActivity();
  }

  /** The teardown `stop()` makes of the daemon's session timers and process-wide listeners. */
  stopTimers(): void {
    this.stopSessionTimers();
  }

  /** The heartbeat monitor `start()` arms once the control socket can hear from owners. */
  startMonitor(): void {
    this.startHeartbeatMonitor();
  }

  stopMonitor(): void {
    void this.runtime.heartbeatMonitor?.stop();
  }

  /** Stops the heartbeat monitor and waits for its in-flight pass to settle. */
  async stopMonitorAndWait(): Promise<void> {
    await this.runtime.heartbeatMonitor?.stop();
  }
}
