import type { BootedDevice } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyClient } from "../observe/android";
import type {
  TalkBackNavigationDriver,
  TalkBackNavigationDriverFactory,
} from "./TalkBackNavigationDriver";
import { DefaultTalkBackNavigationDriver } from "./DefaultTalkBackNavigationDriver";

/**
 * Default factory implementation for TalkBackNavigationDriver.
 */
export class DefaultTalkBackNavigationDriverFactory implements TalkBackNavigationDriverFactory {
  constructor(private readonly adbFactory: AdbClientFactory) {}

  createDriver(device: BootedDevice): TalkBackNavigationDriver {
    return new DefaultTalkBackNavigationDriver(
      AndroidCtrlProxyClient.getInstance(device, this.adbFactory),
    );
  }
}
