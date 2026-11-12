import type { BlePeripheralSidecar } from "../../src/features/blePeripheral/BlePeripheralManager";
import type {
  BleNotification,
  BlePeripheralConfig,
  BleSidecarStatus,
} from "../../src/features/blePeripheral/blePeripheralSchema";

export class FakeBlePeripheralSidecar implements BlePeripheralSidecar {
  config?: BlePeripheralConfig;
  python?: string;
  starts = 0;
  stops = 0;
  startGate?: Promise<void>;
  statusGate?: Promise<void>;
  statusCalls = 0;
  stopError?: Error;
  notifications: BleNotification[] = [];
  snapshot: BleSidecarStatus = {
    running: false,
    advertising: false,
    connected: [],
    subscribed: [],
    pythonReady: true,
    bumbleReady: true,
  };

  async start(python: string, config: BlePeripheralConfig, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.starts++;
    this.python = python;
    this.config = config;
    await this.startGate;
    signal.throwIfAborted();
    this.snapshot = { ...this.snapshot, running: true, advertising: true };
  }
  async notify(value: BleNotification): Promise<void> {
    if (!this.snapshot.running) {
      throw new Error("stopped");
    }
    this.notifications.push(value);
  }
  async status(): Promise<BleSidecarStatus> {
    this.statusCalls++;
    await this.statusGate;
    return this.snapshot;
  }
  async stop(): Promise<void> {
    this.stops++;
    if (this.stopError) {
      throw this.stopError;
    }
    this.snapshot = {
      ...this.snapshot,
      running: false,
      advertising: false,
      connected: [],
      subscribed: [],
    };
  }
}
