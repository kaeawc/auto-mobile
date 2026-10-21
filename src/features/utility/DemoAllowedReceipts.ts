/**
 * The `sysui_demo_allowed` value each device held before the first override enabled it (#14741).
 * Controllers are created per tool call, so the value outlives any one controller; a `null` entry
 * means the setting was unset.
 */
export interface DemoAllowedReceipts {
  has(deviceId: string): boolean;
  save(deviceId: string, value: string | null): void;
  take(deviceId: string): string | null | undefined;
}

export class InMemoryDemoAllowedReceipts implements DemoAllowedReceipts {
  private readonly values = new Map<string, string | null>();
  has(deviceId: string): boolean {
    return this.values.has(deviceId);
  }
  save(deviceId: string, value: string | null): void {
    this.values.set(deviceId, value);
  }
  take(deviceId: string): string | null | undefined {
    const value = this.values.get(deviceId);
    this.values.delete(deviceId);
    return value;
  }
}

export const defaultDemoAllowedReceipts = new InMemoryDemoAllowedReceipts();
