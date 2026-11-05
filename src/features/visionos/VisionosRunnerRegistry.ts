import { ActionableError } from "../../models/ActionableError";
import type { VisionosRunnerClient } from "./VisionosRunnerClient";
/** Explicit device-to-endpoint binding; never guess which visionos owns a localhost port. */
export class VisionosRunnerRegistry {
  private readonly clients = new Map<string, VisionosRunnerClient>();
  get(deviceId: string): VisionosRunnerClient | undefined {
    return this.clients.get(deviceId);
  }
  require(deviceId: string): VisionosRunnerClient {
    const client = this.get(deviceId);
    if (!client) {
      throw new ActionableError(
        `Start and connect the visionos XCUITest runner for ${deviceId} before acting.`,
      );
    }
    return client;
  }
  register(deviceId: string, client: VisionosRunnerClient): () => void {
    if (this.clients.has(deviceId)) {
      throw new ActionableError(`A visionos runner is already registered for ${deviceId}.`);
    }
    this.clients.set(deviceId, client);
    return () => {
      if (this.clients.get(deviceId) === client) {
        this.clients.delete(deviceId);
      }
    };
  }
}
export const visionosRunners = new VisionosRunnerRegistry();
