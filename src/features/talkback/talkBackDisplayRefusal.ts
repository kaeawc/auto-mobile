import { ActionableError } from "../../models/ActionableError";

/**
 * TalkBack activation and scrolling go through the shared CtrlProxy driver, which has no
 * display-addressed request. On a non-default display a raw gesture would only move
 * accessibility focus, so the action is refused before anything is dispatched (#9690, #9905).
 */
export function talkBackDisplayRefusal(
  displayId: number | undefined,
  capability: "coordinate activation" | "scrolling" = "coordinate activation",
): ActionableError | undefined {
  if (displayId === undefined || displayId === 0) {
    return undefined;
  }
  return new ActionableError(
    `TalkBack ${capability} cannot target display ${displayId}; no gesture was dispatched.`,
  );
}
