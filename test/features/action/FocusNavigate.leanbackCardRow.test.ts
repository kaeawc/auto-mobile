import { beforeEach, describe, expect, test } from "bun:test";
import {
  FocusNavigate,
  type FocusKeyPresser,
  type FocusObserver,
  type FocusScreen,
} from "../../../src/features/action/FocusNavigate";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import type { Element } from "../../../src/models/Element";
import { FakeTimer } from "../../fakes/FakeTimer";

// Reconstructed from the #17376 report (Leanback fixture, Android TV API 36, tv_1080p) and the
// fixture's CardPresenter: each card is a focusable ImageCardView with no label of its own whose
// first child is the shared `main_image` ImageView, followed by the title and content TextViews.
// The focused card stays in the same slot while the row scrolls under it. Not a parser fixture:
// the observer hands FocusNavigate Elements.
const PACKAGE = "dev.jasonpearson.automobile.leanbackfixture";
const TITLES = Array.from({ length: 12 }, (_, i) => `Shows ${String(i + 1).padStart(2, "0")}`);
const CARD_WIDTH = 392;
const CARD_GAP = 24;
const ROW_TOP = 700;
const IMAGE_BOTTOM = ROW_TOP + 220;
const ROW_BOTTOM = IMAGE_BOTTOM + 112;
const FIRST_LEFT = 264;
/** Leanback keeps the focused card in a fixed alignment slot once the row has scrolled. */
const FOCUS_SLOT = 1;
const VISIBLE_CARDS = 4;

/** A Leanback row whose focused card keeps its bounds: each RIGHT scrolls the next card in. */
class FakeLeanbackRow implements FocusObserver, FocusKeyPresser {
  focusIndex = 1;
  readonly presses: InputKeyName[] = [];

  private cardAt(slot: number): Element[] | undefined {
    const index = this.focusIndex - FOCUS_SLOT + slot;
    const title = TITLES[index];
    if (title === undefined) {
      return undefined;
    }
    const left = FIRST_LEFT + slot * (CARD_WIDTH + CARD_GAP);
    const right = left + CARD_WIDTH;
    const id = `card_shows_${String(index + 1).padStart(2, "0")}`;
    return [
      {
        bounds: { left, top: ROW_TOP, right, bottom: ROW_BOTTOM },
        class: "androidx.leanback.widget.ImageCardView",
        focusable: true,
        clickable: true,
        ...(slot === FOCUS_SLOT ? { focused: true } : {}),
      },
      {
        bounds: { left, top: ROW_TOP, right, bottom: IMAGE_BOTTOM },
        class: "android.widget.ImageView",
        "resource-id": `${PACKAGE}:id/main_image`,
      },
      {
        bounds: {
          left: left + 22,
          top: IMAGE_BOTTOM + 14,
          right: right - 22,
          bottom: IMAGE_BOTTOM + 58,
        },
        class: "android.widget.TextView",
        "resource-id": `${PACKAGE}:id/title_text`,
        text: title,
      },
      {
        bounds: {
          left: left + 22,
          top: IMAGE_BOTTOM + 62,
          right: right - 22,
          bottom: ROW_BOTTOM - 14,
        },
        class: "android.widget.TextView",
        "resource-id": `${PACKAGE}:id/content_text`,
        text: id,
      },
    ];
  }

  async read(): Promise<FocusScreen> {
    const cards = Array.from({ length: VISIBLE_CARDS }, (_, slot) => this.cardAt(slot));
    const focused = cards[FOCUS_SLOT]?.[0] ?? null;
    return { focused, elements: cards.flatMap((card) => card ?? []) };
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.presses.push(key);
    if (key === "arrow_right" && this.focusIndex < TITLES.length - 1) {
      this.focusIndex += 1;
    }
    if (key === "arrow_left" && this.focusIndex > 0) {
      this.focusIndex -= 1;
    }
    return { success: true };
  }
}

describe("FocusNavigate on a Leanback ImageCardView row (#17376)", () => {
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  test("labels the focused card by its title, not the shared main_image resource-id", async () => {
    const row = new FakeLeanbackRow();
    const result = await new FocusNavigate(row, row, timer).execute({
      until: { text: "Shows 12" },
      direction: "right",
    });

    expect(result.status).toBe("focused");
    expect(result.steps).toBe(10);
    expect(result.path.map((entry) => entry.descendantLabel)).toEqual(TITLES.slice(1, 12));
  });

  test("navigates left back to the first card", async () => {
    const row = new FakeLeanbackRow();
    row.focusIndex = 10;
    const result = await new FocusNavigate(row, row, timer).execute({
      until: { text: "Shows 01" },
      direction: "left",
    });

    expect(result.status).toBe("focused");
    expect(result.focusedElement?.descendantLabel).toBe("Shows 01");
  });

  test("a press at the row's end still reads as not moving", async () => {
    const row = new FakeLeanbackRow();
    row.focusIndex = TITLES.length - 1;
    const result = await new FocusNavigate(row, row, timer).execute({
      until: { text: "Missing" },
      direction: "right",
    });

    expect(result.status).toBe("stuck");
    expect(result.steps).toBe(2);
  });
});
