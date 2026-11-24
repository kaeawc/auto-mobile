import type { SimHidClient } from "../../../../src/utils/ios/simHid/SimHidClient";
import type {
  SimHidHelperBuild,
  SimHidHelperProvider,
} from "../../../../src/utils/ios/simHid/SimHidHelperProvider";
import type {
  SimHidProcessHandle,
  SimHidProcessLauncher,
  SimHidTransport,
} from "../../../../src/utils/ios/simHid/SimHidProcessLauncher";
import type { SimHidCommand, SimHidOutcome } from "../../../../src/utils/ios/simHid/SimHidProtocol";

/** In-memory line transport: records written lines and lets the test answer them. */
export class FakeSimHidTransport implements SimHidTransport {
  readonly sent: string[] = [];
  private readonly lineListeners: Array<(line: string) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  isClosed = false;
  failWrites = false;

  send(line: string): void {
    if (this.failWrites) {
      throw new Error("EPIPE");
    }
    this.sent.push(line);
  }
  onLine(listener: (line: string) => void): void {
    this.lineListeners.push(listener);
  }
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }
  close(): void {
    this.exit();
  }
  /** Simulates the helper exiting. */
  exit(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    for (const listener of this.closeListeners) {
      listener();
    }
  }
  reply(line: string): void {
    for (const listener of this.lineListeners) {
      listener(line);
    }
  }
}

export class FakeSimHidProvider implements SimHidHelperProvider {
  calls = 0;
  failure?: Error;
  async ensure(): Promise<SimHidHelperBuild> {
    this.calls++;
    if (this.failure) {
      throw this.failure;
    }
    return { path: "/cache/sim-hid-helper", env: { DEVELOPER_DIR: "/Xcode" } };
  }
}

export class FakeSimHidLauncher implements SimHidProcessLauncher {
  readonly launches: Array<{ deviceId: string; transport: FakeSimHidTransport; kills: number }> =
    [];
  failure?: Error;
  /** When set, launch() waits on this promise before resolving. */
  gate?: Promise<void>;

  async launch(request: { helperPath: string; deviceId: string }): Promise<SimHidProcessHandle> {
    if (this.gate) {
      await this.gate;
    }
    if (this.failure) {
      throw this.failure;
    }
    const record = { deviceId: request.deviceId, transport: new FakeSimHidTransport(), kills: 0 };
    this.launches.push(record);
    return {
      transport: record.transport,
      kill: () => {
        record.kills++;
      },
    };
  }
}

/** A client that answers every command with a scripted outcome. */
export class FakeSimHidClient implements SimHidClient {
  readonly commands: Array<{ command: SimHidCommand; timeoutMs: number }> = [];
  closed = false;
  constructor(public outcome: SimHidOutcome = { status: "delivered", elapsedMs: 1 }) {}
  async send(command: SimHidCommand, timeoutMs: number): Promise<SimHidOutcome> {
    this.commands.push({ command, timeoutMs });
    return this.outcome;
  }
  close(): void {
    this.closed = true;
  }
}

/** Session access whose helper is either running (`client`) or absent. */
export class FakeSimHidSessionAccess {
  readyCalls = 0;
  acquireCalls: number[] = [];
  constructor(
    public readyClient?: FakeSimHidClient,
    public acquiredClient?: FakeSimHidClient,
  ) {}
  ready(_deviceId: string): SimHidClient | undefined {
    this.readyCalls++;
    return this.readyClient;
  }
  async acquire(_deviceId: string, waitMs: number): Promise<SimHidClient | undefined> {
    this.acquireCalls.push(waitMs);
    return this.acquiredClient;
  }
}
