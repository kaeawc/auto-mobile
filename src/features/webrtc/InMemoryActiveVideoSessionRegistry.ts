import type { ActiveVideoSessionRegistry } from "./PersistentEncoderH264Source";

export const EMPTY_SOCKET_NAME_SET: ReadonlySet<string> = new Set<string>();

export class InMemoryActiveVideoSessionRegistry implements ActiveVideoSessionRegistry {
  private readonly byDevice = new Map<string, Set<string>>();

  add(deviceId: string, socketName: string): void {
    const existing = this.byDevice.get(deviceId);
    if (existing) {
      existing.add(socketName);
      return;
    }
    this.byDevice.set(deviceId, new Set([socketName]));
  }

  remove(deviceId: string, socketName: string): void {
    const existing = this.byDevice.get(deviceId);
    if (!existing) {
      return;
    }
    existing.delete(socketName);
    if (existing.size === 0) {
      this.byDevice.delete(deviceId);
    }
  }

  active(deviceId: string): ReadonlySet<string> {
    return this.byDevice.get(deviceId) ?? EMPTY_SOCKET_NAME_SET;
  }
}
