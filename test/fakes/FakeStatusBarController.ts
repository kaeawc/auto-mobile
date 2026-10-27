import type {
  StatusBarApplyOutcome,
  StatusBarController,
  StatusBarOverrides,
} from "../../src/features/utility/StatusBarOverride";
import { requestedStatusBarFields } from "../../src/features/utility/StatusBarOverride";

/** Records override/clear/read calls; every requested field applies unless marked unsupported. */
export class FakeStatusBarController implements StatusBarController {
  overrides: StatusBarOverrides[] = [];
  clears = 0;
  reads = 0;
  unsupportedFields = new Set<keyof StatusBarOverrides>();
  readback: string | null = "readback";
  clearError: Error | null = null;
  /** When set, clear() waits for the signal to abort, then rejects with its reason. */
  hangClear = false;
  lastClearSignal: AbortSignal | undefined;

  async override(overrides: StatusBarOverrides): Promise<StatusBarApplyOutcome> {
    this.overrides.push(overrides);
    const fields = requestedStatusBarFields(overrides);
    return {
      applied: fields.filter((field) => !this.unsupportedFields.has(field)),
      unsupported: fields.filter((field) => this.unsupportedFields.has(field)),
    };
  }

  async clear(signal?: AbortSignal): Promise<void> {
    this.clears++;
    this.lastClearSignal = signal;
    if (this.hangClear) {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (this.clearError) {
      throw this.clearError;
    }
  }

  async read(): Promise<string | null> {
    this.reads++;
    return this.readback;
  }
}
