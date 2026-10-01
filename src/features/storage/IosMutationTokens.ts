/** Launch-scoped, daemon-local authorization for iOS SDK storage writes. */
export class IosMutationTokens {
  private readonly byDevice = new Map<string, Map<string, string>>();

  get(deviceId: string, appId: string): string | undefined {
    return this.byDevice.get(deviceId)?.get(appId);
  }

  set(deviceId: string, appId: string, token: string): void {
    const apps = this.byDevice.get(deviceId) ?? new Map<string, string>();
    apps.set(appId, token);
    this.byDevice.set(deviceId, apps);
  }

  clear(deviceId: string, appId: string, expectedToken?: string): void {
    const apps = this.byDevice.get(deviceId);
    if (!apps || (expectedToken && apps.get(appId) !== expectedToken)) {
      return;
    }
    apps.delete(appId);
    if (apps.size === 0) {
      this.byDevice.delete(deviceId);
    }
  }
}

export const iosMutationTokens = new IosMutationTokens();
