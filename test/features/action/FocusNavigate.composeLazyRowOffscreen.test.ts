import { beforeEach, describe, expect, test } from "bun:test";
import {
  FocusNavigate,
  type FocusKeyPresser,
  type FocusObserver,
  type FocusPathEntry,
  type FocusScreen,
} from "../../../src/features/action/FocusNavigate";
import { DpadTapOn } from "../../../src/features/action/DpadTapOn";
import type { DpadTargetResolver } from "../../../src/features/action/DpadTargetResolver";
import { elementMatchesTarget } from "../../../src/features/action/FocusNavigateMatching";
import { findRowAnchor } from "../../../src/features/action/FocusRowSearch";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import type { Element } from "../../../src/models/Element";
import type { ElementBounds } from "../../../src/models/ElementBounds";
import { FakeTimer } from "../../fakes/FakeTimer";
import captured from "../../fixtures/android-tv-compose-home/focus-navigate-offscreen-card.json";

// The #18027 Compose for TV home screen, built from the captured results (see the fixture README):
// a Settings button above three LazyRows of 8 cards, of which only 5 are composed at a time.
const capturedPath: FocusPathEntry[] = captured.focusNavigateFromNoFocus.path;
const [SETTINGS, TRENDING_1, MIDDLE_1, DOCUMENTARIES_1] = capturedPath;
const ROWS = [
  { bounds: TRENDING_1.bounds, label: "Trending card" },
  // The middle row's cards carried no label in the capture.
  { bounds: MIDDLE_1.bounds, label: undefined },
  { bounds: DOCUMENTARIES_1.bounds, label: "Documentaries card" },
];
const CARDS_PER_ROW = 8;
const COMPOSED_CARDS = 5;
/** Cards fully on the 1920 px display; focus beyond them scrolls the row. */
const FULLY_VISIBLE_CARDS = 4;
/** Card 2's left edge (488) in the #18028 observe capture, less card 1's (64). */
const CARD_STRIDE = 424;

type Focus = { kind: "none" } | { kind: "settings" } | { kind: "card"; row: number; col: number };

function inset(bounds: ElementBounds): ElementBounds {
  return {
    left: bounds.left + 16,
    top: bounds.bottom - 64,
    right: bounds.right - 16,
    bottom: bounds.bottom - 16,
  };
}

class FakeComposeTvHome implements FocusObserver, FocusKeyPresser {
  focus: Focus = { kind: "none" };
  readonly presses: InputKeyName[] = [];
  /** First composed card of each row. */
  private readonly start = ROWS.map(() => 0);

  private cardBounds(row: number, col: number): ElementBounds {
    const first = ROWS[row].bounds;
    const left = first.left + (col - this.start[row]) * CARD_STRIDE;
    return { ...first, left, right: left + (first.right - first.left) };
  }

  private node(bounds: ElementBounds, id: string, label: string | undefined, focused: boolean) {
    const card: Element = {
      bounds,
      "view-id": id,
      clickable: "true",
      focusable: "true",
      ...(focused ? { focused: true } : {}),
    };
    return label ? [card, { bounds: inset(bounds), text: label }] : [card];
  }

  private isFocused(row: number, col: number): boolean {
    return this.focus.kind === "card" && this.focus.row === row && this.focus.col === col;
  }

  async read(): Promise<FocusScreen> {
    const settings = this.node(SETTINGS.bounds, "s2-settings", "Settings", false);
    if (this.focus.kind === "settings") {
      settings[0] = { ...settings[0], focused: true };
    }
    const cards = ROWS.flatMap(({ label }, row) =>
      Array.from({ length: COMPOSED_CARDS }, (_, slot) => this.start[row] + slot)
        .filter((col) => col < CARDS_PER_ROW)
        .flatMap((col) =>
          this.node(
            this.cardBounds(row, col),
            `s2-${row}-${col}`,
            label && `${label} ${col + 1}`,
            this.isFocused(row, col),
          ),
        ),
    );
    const elements = [...settings, ...cards];
    return { focused: elements.find((element) => element.focused === true) ?? null, elements };
  }

  private focusCard(row: number, col: number): void {
    const start = this.start[row];
    this.start[row] = Math.min(Math.max(start, col - FULLY_VISIBLE_CARDS + 1), col);
    this.focus = { kind: "card", row, col };
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.presses.push(key);
    const { focus } = this;
    if (focus.kind === "none") {
      if (key === "arrow_down") {
        this.focus = { kind: "settings" };
      }
    } else if (focus.kind === "settings") {
      if (key === "arrow_down") {
        this.focusCard(0, this.start[0]);
      }
    } else {
      this.moveCard(focus.row, focus.col, key);
    }
    return { success: true };
  }

  private moveCard(row: number, col: number, key: InputKeyName): void {
    const slot = col - this.start[row];
    if (key === "arrow_right" && col + 1 < CARDS_PER_ROW) {
      this.focusCard(row, col + 1);
    } else if (key === "arrow_left" && col > 0) {
      this.focusCard(row, col - 1);
    } else if (key === "arrow_down" && row + 1 < ROWS.length) {
      this.focusCard(row + 1, this.start[row + 1] + slot);
    } else if (key === "arrow_up") {
      if (row === 0) {
        this.focus = { kind: "settings" };
      } else {
        this.focusCard(row - 1, this.start[row - 1] + slot);
      }
    }
  }
}

function labels(path: readonly FocusPathEntry[]): (string | undefined)[] {
  return path.map((entry) => entry.descendantLabel);
}

const TRENDING = Array.from({ length: CARDS_PER_ROW }, (_, i) => `Trending card ${i + 1}`);

describe("FocusNavigate to a LazyRow card that is not composed yet (#18027)", () => {
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  test("the fake starts where the capture did: card 8 is absent and card 1 is first", async () => {
    const home = new FakeComposeTvHome();
    const screen = await home.read();
    const texts = screen.elements.map((element) => element.text).filter(Boolean);
    expect(texts).toContain("Trending card 5");
    expect(texts).not.toContain("Trending card 8");
    expect(screen.focused).toBeNull();
    expect(captured.focusNavigateFromNoFocus.focusedElement.descendantLabel).toBe(
      "Documentaries card 1",
    );
  });

  test("from no focus, enters the Trending row and searches right instead of walking down", async () => {
    const home = new FakeComposeTvHome();
    const result = await new FocusNavigate(home, home, timer).execute({
      until: { label: "Trending card 8" },
    });

    expect(result.status).toBe("focused");
    expect(result.focusedElement?.descendantLabel).toBe("Trending card 8");
    expect(labels(result.path)).toEqual(["Settings", ...TRENDING]);
    expect(home.presses).toEqual(["arrow_down", "arrow_down", ...Array(7).fill("arrow_right")]);
  });

  test("from Trending card 1, reaches card 8 with the 7 right presses the capture needed", async () => {
    const home = new FakeComposeTvHome();
    home.focus = { kind: "card", row: 0, col: 0 };
    const result = await new FocusNavigate(home, home, timer).execute({
      until: { label: "Trending card 8" },
    });

    expect(result.status).toBe("focused");
    expect(result.steps).toBe(7);
    expect(labels(result.path)).not.toContain("Documentaries card 1");
  });

  test("a card the row never holds ends in that row with an error naming it", async () => {
    const home = new FakeComposeTvHome();
    home.focus = { kind: "card", row: 0, col: 0 };
    const result = await new FocusNavigate(home, home, timer).execute({
      until: { label: "Trending card 9" },
    });

    expect(result.status).toBe("stuck");
    expect(labels(result.path).every((label) => label?.startsWith("Trending card"))).toBe(true);
    expect(result.focusedElement?.descendantLabel).toBe("Trending card 1");
    expect(result.message).toBe(
      '"Trending card 9" was not on screen in any read: D-pad right and left reached both ends ' +
        'of the row of "Trending card …" items without it; focus ended on "Trending card 1". ' +
        "Check the label, or scroll that row into view another way; the target was not focused. " +
        "Observe before retrying.",
    );
  });

  test("a label no on-screen row resembles still scans down, and says it was never on screen", async () => {
    const home = new FakeComposeTvHome();
    const result = await new FocusNavigate(home, home, timer).execute({
      until: { label: "Kids card 3" },
    });

    expect(result.status).toBe("stuck");
    expect(result.focusedElement?.descendantLabel).toBe("Documentaries card 1");
    expect(result.message).toStartWith(
      '"Kids card 3" was not on screen in any read and no on-screen row holds labels like it',
    );
    expect(result.message).toContain('focus ended on "Documentaries card 1"');
  });

  test("tapOn's D-pad path finds the card although its pinned target is null until composed", async () => {
    const home = new FakeComposeTvHome();
    const resolver: DpadTargetResolver = {
      resolve: (screen, target) =>
        screen.elements.find((element) => elementMatchesTarget(element, target))?.bounds ?? null,
    };
    const result = await new DpadTapOn(
      new FocusNavigate(home, home, timer),
      home,
      resolver,
    ).execute({ label: "Trending card 8" });

    expect(result.success).toBe(true);
    expect(home.presses.at(-1)).toBe("enter");
    expect(captured.tapOnFromNoFocus.success).toBe(false);
  });

  test("a one-word label, a row header and a vertical list have no row to search", () => {
    const below = { ...TRENDING_1.bounds, top: 504, bottom: 724 };
    const beside = { ...TRENDING_1.bounds, left: 488, right: 888 };
    expect(
      findRowAnchor([{ bounds: TRENDING_1.bounds, text: "Search" }], { label: "Settings" }),
    ).toBe(undefined);
    expect(
      findRowAnchor([{ bounds: TRENDING_1.bounds, text: "Trending" }], { label: "Trending 8" }),
    ).toBe(undefined);
    const stacked = [
      { bounds: TRENDING_1.bounds, text: "Item 1" },
      { bounds: below, text: "Item 2" },
    ];
    expect(findRowAnchor(stacked, { label: "Item 6" })).toBe(undefined);
    // One card labelled twice: a parent's content-desc and its child's text.
    const nested = [
      { bounds: TRENDING_1.bounds, "content-desc": "Item 1" },
      { bounds: TRENDING_1.bounds, text: "Item 1" },
    ];
    expect(findRowAnchor(nested, { label: "Item 2" })).toBe(undefined);
    const row = [
      { bounds: TRENDING_1.bounds, text: "Item 1" },
      { bounds: beside, text: "Item 2" },
    ];
    expect(findRowAnchor(row, { label: "Item 6" })?.name).toBe("Item");
  });
});
