import { EventEmitter } from "node:events";
import type {
  IosScreenCaptureHelperEvents,
  IosScreenCaptureHelperOptions,
} from "./IosScreenCaptureHelper";
import type { IosSimulatorCaptureHelperLease } from "./IosSimulatorCaptureHelperPool";

export interface PooledSimulatorCaptureHelperLeaseHost {
  attach(lease: PooledSimulatorCaptureHelperLease): Promise<void>;
  detach(lease: PooledSimulatorCaptureHelperLease): Promise<void>;
  invalidate(lease: PooledSimulatorCaptureHelperLease): Promise<void>;
  requestKeyFrame(lease: PooledSimulatorCaptureHelperLease): boolean;
}

export class PooledSimulatorCaptureHelperLease
  extends EventEmitter
  implements IosSimulatorCaptureHelperLease
{
  private started = false;
  private attachment: Promise<void> | null = null;
  private attachmentGeneration = 0;
  entryKey: string | null = null;

  constructor(
    private readonly pool: PooledSimulatorCaptureHelperLeaseHost,
    readonly options: IosScreenCaptureHelperOptions,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("IOSSimulatorCaptureHelperLease already started");
    }
    this.started = true;
    const attachment = this.pool.attach(this);
    const attachmentGeneration = ++this.attachmentGeneration;
    this.attachment = attachment;
    try {
      await attachment;
    } catch (error) {
      this.started = false;
      throw error;
    } finally {
      if (this.attachmentGeneration === attachmentGeneration) {
        this.attachment = null;
      }
    }
  }

  async stop(): Promise<null> {
    if (!this.started) {
      return null;
    }
    this.started = false;
    this.removeAllListeners();
    await this.attachment?.catch(() => undefined);
    await this.pool.detach(this);
    return null;
  }

  async invalidate(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.removeAllListeners();
    await this.attachment?.catch(() => undefined);
    await this.pool.invalidate(this);
  }

  requestKeyFrame(): boolean {
    return this.started && this.pool.requestKeyFrame(this);
  }

  get isStarted(): boolean {
    return this.started;
  }

  forward<E extends keyof IosScreenCaptureHelperEvents>(
    event: E,
    value: Parameters<IosScreenCaptureHelperEvents[E]>[0],
  ): void {
    if (this.started) {
      this.emit(event, value);
    }
  }
}
