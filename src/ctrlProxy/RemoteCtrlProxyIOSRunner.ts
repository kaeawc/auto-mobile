export interface RemoteCtrlProxyIOSRunner {
  isEnabled(): boolean;
  isRunningInDocker(): boolean;
  isAvailable(): Promise<boolean>;
  getHost(): string;
  runIdeviceId(
    args: string[],
  ): Promise<{ success: boolean; error?: string; data?: { stdout: string } }>;
  runIdeviceInstaller(
    args: string[],
  ): Promise<{ success: boolean; error?: string; data?: { stdout: string } }>;
  runSimctl(
    args: string[],
  ): Promise<{ success: boolean; error?: string; data?: { stdout: string } }>;
  startIproxy(params: {
    deviceId: string;
    localPort: number;
    devicePort?: number;
  }): Promise<{ success: boolean; error?: string; data?: { pid: number } }>;
  stopIproxy(params: {
    pid?: number;
    deviceId?: string;
    localPort?: number;
    devicePort?: number;
  }): Promise<{ success: boolean; error?: string }>;
  getIproxyStatus(params: {
    pid?: number;
    deviceId?: string;
    localPort?: number;
    devicePort?: number;
  }): Promise<{ success: boolean; error?: string; data?: { running: boolean; pid?: number } }>;
  start(params: {
    deviceId: string;
    port: number;
    xctestrunPath?: string;
    bundleId?: string;
    timeoutSeconds?: number;
  }): Promise<{
    success: boolean;
    error?: string;
    data?: { pid: number; message: string; port?: number };
  }>;
  stop(params: { deviceId?: string; pid?: number }): Promise<{ success: boolean; error?: string }>;
  status(params: { deviceId?: string; pid?: number; port?: number }): Promise<{
    success: boolean;
    error?: string;
    data?: { running: boolean; pid?: number; port?: number };
  }>;
}

/** Host-control runner used when none is configured: every call reports it is disabled. */
export const DISABLED_REMOTE_RUNNER: RemoteCtrlProxyIOSRunner = {
  isEnabled: () => false,
  isRunningInDocker: () => false,
  isAvailable: async () => false,
  getHost: () => "localhost",
  runIdeviceId: async () => ({ success: false, error: "Remote runner is disabled" }),
  runIdeviceInstaller: async () => ({ success: false, error: "Remote runner is disabled" }),
  runSimctl: async () => ({ success: false, error: "Remote runner is disabled" }),
  startIproxy: async () => ({ success: false, error: "Remote runner is disabled" }),
  stopIproxy: async () => ({ success: false, error: "Remote runner is disabled" }),
  getIproxyStatus: async () => ({ success: false, error: "Remote runner is disabled" }),
  start: async () => ({ success: false, error: "Remote runner is disabled" }),
  stop: async () => ({ success: false, error: "Remote runner is disabled" }),
  status: async () => ({ success: false, error: "Remote runner is disabled" }),
};
