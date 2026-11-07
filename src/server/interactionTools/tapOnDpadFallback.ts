import { DpadTapOn } from "../../features/action/DpadTapOn";
import { SelectorDpadTargetResolver } from "../../features/action/DpadTargetResolver";
import { ResolverElementSelector } from "../../features/utility/ResolverElementSelector";
import { FocusNavigate } from "../../features/action/FocusNavigate";
import { RealObserveScreen } from "../../features/observe/ObserveScreen";
import type { BootedDevice } from "../../models";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultTouchscreenFeature } from "../../utils/android-cmdline-tools/touchscreenFeature";
import { defaultTimer } from "../../utils/SystemTimer";
import {
  createFocusKeyboardHider,
  createFocusKeyPresser,
  createFocusNavigateObserver,
} from "../focusNavigateTool";
import type { TapOnDpadFallbackLike } from "./dependencies";

/** The production D-pad tapOn: real touchscreen probe, hierarchy reads and key presses. */
export function defaultTapOnDpadFallbackFactory(device: BootedDevice): TapOnDpadFallbackLike {
  return {
    hasTouchscreen: (signal) =>
      defaultTouchscreenFeature.hasTouchscreen(
        defaultAdbClientFactory.create(device),
        device.deviceId,
        signal,
      ),
    tap: (target, signal) => {
      const keys = createFocusKeyPresser(device);
      const navigator = new FocusNavigate(
        createFocusNavigateObserver(new RealObserveScreen(device, defaultAdbClientFactory)),
        keys,
        defaultTimer,
        createFocusKeyboardHider(device),
      );
      const resolver = new SelectorDpadTargetResolver(new ResolverElementSelector());
      return new DpadTapOn(navigator, keys, resolver).execute(target, signal);
    },
  };
}
