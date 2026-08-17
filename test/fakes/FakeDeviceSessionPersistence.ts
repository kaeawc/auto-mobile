import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";

export class FakeDeviceSessionPersistence implements DeviceSessionPersistence {
  failure: "create" | "release" | null = null;
  createFailureOnAttempt: number | null = null;
  private createAttempts = 0;

  async upsertActiveSession(): Promise<void> {
    this.createAttempts++;
    if (this.failure === "create" || this.createFailureOnAttempt === this.createAttempts) {
      throw new Error("persist create failed");
    }
  }

  async recordActivity(): Promise<void> {}

  async markReleased(): Promise<void> {
    if (this.failure === "release") {
      throw new Error("persist release failed");
    }
  }
}
