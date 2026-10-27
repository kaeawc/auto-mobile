import { type BootedDevice } from "../../models";
import { AndroidCtrlProxyClient } from "../observe/android";
import type {
  FocusNavigationDriver,
  FocusNavigationDriverFactory,
} from "./FocusNavigationExecutor";
import { DefaultFocusNavigationDriver } from "./DefaultFocusNavigationDriver";

export class DefaultFocusNavigationDriverFactory implements FocusNavigationDriverFactory {
  createDriver(device: BootedDevice): FocusNavigationDriver {
    return new DefaultFocusNavigationDriver(AndroidCtrlProxyClient.getInstance(device));
  }
}
