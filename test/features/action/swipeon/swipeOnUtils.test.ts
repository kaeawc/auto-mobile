import { describe, it, expect } from "bun:test";
import {
  resolveSwipeDirection,
  resolveSwipeDirectionRaw,
  SCROLL_TO_FINGER_DIRECTION,
} from "../../../../src/features/action/swipeon/swipeOnUtils";
import { SwipeDirection } from "../../../../src/models";

describe("SCROLL_TO_FINGER_DIRECTION", () => {
  it("maps all four scroll directions to their finger-swipe inverses", () => {
    expect(SCROLL_TO_FINGER_DIRECTION.up).toBe("down");
    expect(SCROLL_TO_FINGER_DIRECTION.down).toBe("up");
    expect(SCROLL_TO_FINGER_DIRECTION.left).toBe("right");
    expect(SCROLL_TO_FINGER_DIRECTION.right).toBe("left");
  });
});

describe("resolveSwipeDirection", () => {
  describe("missing direction", () => {
    it("returns an error when direction is undefined", () => {
      const result = resolveSwipeDirectionRaw({ direction: undefined });
      expect(result.error).toBe("direction is required");
      expect(result.direction).toBeUndefined();
    });
  });

  describe("swipeFingerTowardsDirection (default)", () => {
    it("returns direction unchanged when no gestureType provided", () => {
      const result = resolveSwipeDirection({ direction: "up" });
      expect(result.direction).toBe("up");
      expect(result.error).toBeUndefined();
      expect(result.message).toContain("up");
      expect(result.message).toContain("finger");
    });

    it("returns direction unchanged for explicit swipeFingerTowardsDirection", () => {
      const directions: SwipeDirection[] = ["up", "down", "left", "right"];
      for (const direction of directions) {
        const result = resolveSwipeDirection({
          direction,
          gestureType: "swipeFingerTowardsDirection",
        });
        expect(result.direction).toBe(direction);
        expect(result.error).toBeUndefined();
      }
    });
  });

  describe("scrollTowardsDirection", () => {
    it("inverts 'up' to 'down' (scroll content up → finger moves down)", () => {
      const result = resolveSwipeDirection({
        direction: "up",
        gestureType: "scrollTowardsDirection",
      });
      expect(result.direction).toBe("down");
      expect(result.error).toBeUndefined();
      expect(result.message).toContain("above");
    });

    it("inverts 'down' to 'up' (scroll content down → finger moves up)", () => {
      const result = resolveSwipeDirection({
        direction: "down",
        gestureType: "scrollTowardsDirection",
      });
      expect(result.direction).toBe("up");
      expect(result.error).toBeUndefined();
      expect(result.message).toContain("below");
    });

    it("inverts 'left' to 'right' (scroll content left → finger moves right)", () => {
      const result = resolveSwipeDirection({
        direction: "left",
        gestureType: "scrollTowardsDirection",
      });
      expect(result.direction).toBe("right");
      expect(result.error).toBeUndefined();
      expect(result.message).toContain("from left");
    });

    it("inverts 'right' to 'left' (scroll content right → finger moves left)", () => {
      const result = resolveSwipeDirection({
        direction: "right",
        gestureType: "scrollTowardsDirection",
      });
      expect(result.direction).toBe("left");
      expect(result.error).toBeUndefined();
      expect(result.message).toContain("from right");
    });

    it("includes the original scroll direction in the message", () => {
      const result = resolveSwipeDirection({
        direction: "up",
        gestureType: "scrollTowardsDirection",
      });
      expect(result.message).toContain("up");
    });
  });

  describe("exact response messages", () => {
    it("emits the exact finger-gesture message", () => {
      const result = resolveSwipeDirection({ direction: "up" });
      expect(result.message).toBe("Swiping up (finger gesture)");
    });

    it("emits the exact scroll message with the revealed-content phrase", () => {
      const result = resolveSwipeDirection({
        direction: "up",
        gestureType: "scrollTowardsDirection",
      });
      expect(result.message).toBe("Scrolling up to reveal content above");
    });

    it("reports the missing-direction error verbatim", () => {
      expect(resolveSwipeDirectionRaw({ direction: undefined }).error).toBe(
        "direction is required",
      );
    });
  });
});
