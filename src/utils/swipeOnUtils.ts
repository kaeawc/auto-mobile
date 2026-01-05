import { RevealContentDirection, SwipeDirection, SwipeOnOptions } from "../models";

export const REVEAL_CONTENT_TO_SWIPE_DIRECTION: Record<RevealContentDirection, SwipeDirection> = {
  above: "down",
  below: "up",
  left: "right",
  right: "left"
};

export const resolveSwipeDirection = (
  options: Pick<SwipeOnOptions, "direction" | "revealContent">
): { direction?: SwipeDirection; error?: string } => {
  const { direction, revealContent } = options;

  if (!direction && !revealContent) {
    return { error: "direction or revealContent is required" };
  }

  if (!revealContent) {
    return { direction };
  }

  const mappedDirection = REVEAL_CONTENT_TO_SWIPE_DIRECTION[revealContent];
  if (direction && direction !== mappedDirection) {
    return {
      error: `direction conflicts with revealContent "${revealContent}" (use direction "${mappedDirection}")`
    };
  }

  return { direction: direction ?? mappedDirection };
};
