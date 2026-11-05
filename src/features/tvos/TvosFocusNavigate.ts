/**
 * `focusNavigate` on tvOS (#16722): the shared FocusNavigate loop, observing through the tvOS
 * runner's hierarchy and moving with Siri Remote directional presses. The focus engine remembers
 * the last item per row and column, so the loop re-reads focus after every press instead of
 * planning a path from geometry.
 */

import type { Element } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { Timer } from "../../utils/SystemTimer";
import {
  FocusNavigate,
  focusNavigateTargetError,
  type FocusKeyPresser,
  type FocusNavigateOptions,
  type FocusNavigateResult,
  type FocusObserver,
} from "../action/FocusNavigate";
import type { InputKeyName } from "../action/InputKey";
import { DefaultElementParser } from "../utility/ElementParser";
import { normalizeTvosHierarchy } from "./TvosHierarchy";
import type { TVRemoteButton, TvosRunnerClient } from "./TvosRunnerClient";
import { tvosRunners } from "./TvosRunnerRegistry";

const REMOTE_DIRECTIONS: Partial<Record<InputKeyName, TVRemoteButton>> = {
  arrow_up: "up",
  arrow_down: "down",
  arrow_left: "left",
  arrow_right: "right",
};

const parser = new DefaultElementParser();

function isFocused(element: Element): boolean {
  return element.focused === true || element.focused === "true";
}

/** Reads the runner hierarchy; the focused element is the first focused node in it. */
export function createTvosFocusObserver(
  client: Pick<TvosRunnerClient, "hierarchy">,
): FocusObserver {
  return {
    read: async (signal) => {
      const hierarchy = normalizeTvosHierarchy(await client.hierarchy(signal));
      const elements = parser.flattenViewHierarchy(hierarchy).map(({ element }) => element);
      return { focused: elements.find(isFocused) ?? null, elements };
    },
  };
}

/** Sends D-pad arrows as Siri Remote directional presses; other keys are refused. */
export function createTvosFocusKeyPresser(
  client: Pick<TvosRunnerClient, "request">,
): FocusKeyPresser {
  return {
    press: async (key, signal) => {
      const action = REMOTE_DIRECTIONS[key];
      if (!action) {
        return { success: false, error: `tvOS focusNavigate cannot press ${key}.` };
      }
      await client.request({ type: "request_press_button", action }, signal);
      return { success: true };
    },
  };
}

/** Runs focusNavigate against the runner registered for `deviceId`. */
export async function tvosFocusNavigate(
  deviceId: string,
  options: FocusNavigateOptions,
  timer: Timer,
  runners: Pick<typeof tvosRunners, "require"> = tvosRunners,
): Promise<FocusNavigateResult> {
  const targetError = focusNavigateTargetError(options.until);
  if (targetError) {
    throw new ActionableError(targetError);
  }
  options.signal?.throwIfAborted();
  const client = runners.require(deviceId);
  return new FocusNavigate(
    createTvosFocusObserver(client),
    createTvosFocusKeyPresser(client),
    timer,
  ).execute(options);
}
