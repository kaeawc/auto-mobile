import { ActionableError } from "../../models/ActionableError";
import type { TvosRunnerClient } from "./TvosRunnerClient";
/** Explicit device-to-endpoint binding; never guess which tvos owns a localhost port. */
export class TvosRunnerRegistry {
  private readonly clients = new Map<string, TvosRunnerClient>();
  get(deviceId: string): TvosRunnerClient | undefined {
    return this.clients.get(deviceId);
  }
  require(deviceId: string): TvosRunnerClient {
    const client = this.get(deviceId);
    if (!client) {
      throw new ActionableError(
        `Start and connect the tvos XCUITest runner for ${deviceId} before acting.`,
      );
    }
    return client;
  }
  register(deviceId: string, client: TvosRunnerClient): () => void {
    if (this.clients.has(deviceId)) {
      throw new ActionableError(`A tvos runner is already registered for ${deviceId}.`);
    }
    this.clients.set(deviceId, client);
    return () => {
      if (this.clients.get(deviceId) === client) {
        this.clients.delete(deviceId);
      }
    };
  }
}
export const tvosRunners = new TvosRunnerRegistry();
