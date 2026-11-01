import { ActionableError } from "../../models/ActionableError";
import type { WatchRunnerClient } from "./WatchRunnerClient";
/** Explicit device-to-endpoint binding; never guess which watch owns a localhost port. */
export class WatchRunnerRegistry {
  private readonly clients = new Map<string, WatchRunnerClient>();
  get(deviceId: string): WatchRunnerClient | undefined {
    return this.clients.get(deviceId);
  }
  require(deviceId: string): WatchRunnerClient {
    const client = this.get(deviceId);
    if (!client) {
      throw new ActionableError(
        `Start and connect the watch XCUITest runner for ${deviceId} before acting.`,
      );
    }
    return client;
  }
  register(deviceId: string, client: WatchRunnerClient): () => void {
    if (this.clients.has(deviceId)) {
      throw new ActionableError(`A watch runner is already registered for ${deviceId}.`);
    }
    this.clients.set(deviceId, client);
    return () => {
      if (this.clients.get(deviceId) === client) {
        this.clients.delete(deviceId);
      }
    };
  }
}
export const watchRunners = new WatchRunnerRegistry();
