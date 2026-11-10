import { ActionableError } from "../../models/ActionableError";
import type { VisionosRunnerClient } from "./VisionosRunnerClient";

interface RegisteredRunner {
  client: VisionosRunnerClient;
  /** The window app the runner was started to automate; absent when that is not known. */
  targetBundleId?: string;
}

/** Explicit device-to-endpoint binding; never guess which visionos owns a localhost port. */
export class VisionosRunnerRegistry {
  private readonly runners = new Map<string, RegisteredRunner>();
  get(deviceId: string): VisionosRunnerClient | undefined {
    return this.runners.get(deviceId)?.client;
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
  /**
   * The window app `client` was started to automate, only while it is the registered runner for
   * the device; a replaced or unregistered client, or one registered without a target, has none.
   */
  targetBundleId(deviceId: string, client: VisionosRunnerClient): string | undefined {
    const entry = this.runners.get(deviceId);
    return entry?.client === client ? entry.targetBundleId : undefined;
  }
  register(deviceId: string, client: VisionosRunnerClient, targetBundleId?: string): () => void {
    if (this.runners.has(deviceId)) {
      throw new ActionableError(`A visionos runner is already registered for ${deviceId}.`);
    }
    this.runners.set(deviceId, { client, targetBundleId });
    return () => {
      if (this.runners.get(deviceId)?.client === client) {
        this.runners.delete(deviceId);
      }
    };
  }
}
export const visionosRunners = new VisionosRunnerRegistry();
