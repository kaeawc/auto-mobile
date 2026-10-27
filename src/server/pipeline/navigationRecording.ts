import type { NavigationToolCallHandle } from "../../utils/interfaces/NavigationGraph";
import { BootedDevice } from "../../models";
import {
  NavigationGraphManager,
  type NavigationGraphService,
} from "../../features/navigation/NavigationGraphManager";
import { UIStateExtractor } from "../../features/navigation/UIStateExtractor";
import { RealObserveScreen } from "../../features/observe/ObserveScreen";
import { stripNavigationToolParams } from "../../models/navigationToolParams";
import type { ToolTraits } from "../toolRegistry";

export interface NavigationToolCallRecorder {
  record(
    name: string,
    args: any,
    device: BootedDevice | undefined,
    sessionUuid: string | undefined,
    traits?: ToolTraits,
  ): NavigationToolCallHandle | undefined;
}

/** Removes routing and execution implementation details before persisting a navigation edge. */
export function stripNavigationInternalParams(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return stripNavigationToolParams(args);
}

/**
 * The app a tool call is about to stop or reset, so the navigation graph forgets the screen it
 * was on (#10193): a fresh process must not get an edge from a stale screen. `launchApp` only
 * counts when it asks for a cold boot or cleared data.
 */
function appStoppedByToolCall(name: string, args: any, traits: ToolTraits): string | undefined {
  const stops =
    traits.stopsApp === true ||
    (name === "launchApp" && (args?.coldBoot === true || args?.clearAppData === true));
  const appId = args?.appId ?? args?.packageName;
  return stops && typeof appId === "string" && appId.length > 0 ? appId : undefined;
}

export class DefaultNavigationToolCallRecorder implements NavigationToolCallRecorder {
  record(
    name: string,
    args: any,
    device: BootedDevice | undefined,
    sessionUuid: string | undefined,
    traits: ToolTraits = {},
  ): NavigationToolCallHandle | undefined {
    const stoppedApp = appStoppedByToolCall(name, args, traits);
    if (stoppedApp) {
      this.navigationManager(sessionUuid).forgetAppScreen(stoppedApp);
    }
    if (traits.replacesProcess === true) {
      this.navigationManager(sessionUuid).forgetAllAppScreens();
    }
    // Record tool call for navigation graph correlation before the handler mutates UI state.
    if (traits.recordsNavigation !== true) {
      return;
    }

    const cachedResult = device
      ? RealObserveScreen.getRecentCachedResultForDevice(device.deviceId)
      : RealObserveScreen.getRecentCachedResult();
    const uiState = new UIStateExtractor().extractFromObservation(cachedResult);
    return this.navigationManager(sessionUuid).recordToolCall(
      name,
      stripNavigationInternalParams(args),
      uiState,
      device?.deviceId,
    );
  }

  private navigationManager(sessionUuid: string | undefined): NavigationGraphService {
    return sessionUuid
      ? NavigationGraphManager.getInstanceForSession(sessionUuid)
      : NavigationGraphManager.getInstance();
  }
}
