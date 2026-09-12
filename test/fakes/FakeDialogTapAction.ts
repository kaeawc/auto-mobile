import type { BootedDevice } from "../../src/models";
import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ProgressCallback } from "../../src/features/action/BaseVisualChange";
import type { TapOnElementOptions } from "../../src/models/TapOnElementOptions";
import type {
  DialogTapAction,
  DialogTapActionFactory,
} from "../../src/features/navigation/ExploreBlockerDetection";

/**
 * Fake {@link DialogTapAction} for the Explore blocker handlers.
 *
 * Replaces `spyOn(TapOnElement.prototype, "execute")`: the handlers construct
 * their tap action through an injected {@link DialogTapActionFactory}, so a
 * test passes {@link FakeDialogTapAction.factory} instead of patching a
 * prototype. Records every `execute` call's options for assertions and the
 * `(device, adb)` pairs the handler built actions for.
 */
export class FakeDialogTapAction implements DialogTapAction {
  readonly calls: TapOnElementOptions[] = [];
  readonly builtFor: Array<{ device: BootedDevice; adb: AdbExecutor | null }> = [];
  private readonly result: unknown;
  private readonly error?: Error;

  constructor(options: { result?: unknown; error?: Error } = {}) {
    this.result = options.result ?? { success: true, action: "tap" };
    this.error = options.error;
  }

  async execute(options: TapOnElementOptions, _progress?: ProgressCallback): Promise<unknown> {
    this.calls.push(options);
    if (this.error) {
      throw this.error;
    }
    return this.result;
  }

  /**
   * Factory that records the device/adb pair and returns this recorder, so a
   * single fake captures every tap the handler performs in a test.
   */
  readonly factory: DialogTapActionFactory = (device, adb) => {
    this.builtFor.push({ device, adb });
    return this;
  };
}
