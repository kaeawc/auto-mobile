import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";

export class FakeDeviceSessionPersistence implements DeviceSessionPersistence {
  failure: "create" | "release" | null = null;

  async upsertActiveSession(): Promise<void> {
    if (this.failure === "create") {
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
