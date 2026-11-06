import { beforeEach, describe, expect, test } from "bun:test";
import {
  FOCUS_LIST_ADVANCE_MAX_PRESSES,
  FocusListAdvance,
  listAdvanceDirection,
} from "../../../src/features/action/FocusListAdvance";
import type {
  FocusKeyPresser,
  FocusObserver,
  FocusScreen,
} from "../../../src/features/action/FocusNavigate";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import type { Element } from "../../../src/models/Element";
import type { ElementBounds } from "../../../src/models/ElementBounds";
import { FakeTimer } from "../../fakes/FakeTimer";

const ROW = 100;
/** The list's on-screen box: three 100px rows below a 100px header. */
const LIST: ElementBounds = { left: 0, top: 100, right: 400, bottom: 400 };

/**
 * A virtualized TV list: only `visible` rows of `count` items are in the hierarchy, and the
 * window scrolls only when focus is pressed past its last row. With `wrap`, the last row moves
 * focus back to the first; with `footer`, it moves focus to a button below the list.
 */
class FakeTvList implements FocusObserver, FocusKeyPresser {
  first = 0;
  focus: number | "footer" = 0;
  readonly presses: InputKeyName[] = [];
  failPress: string | undefined;

  constructor(
    private readonly count: number,
    private readonly options: { visible?: number; wrap?: boolean; footer?: boolean } = {},
  ) {}

  private get visible(): number {
    return this.options.visible ?? 3;
  }

  private row(index: number): Element {
    const top = LIST.top + (index - this.first) * ROW;
    return {
      bounds: { left: 0, top, right: 400, bottom: top + ROW },
      "resource-id": "app:id/row",
      text: `Item ${index}`,
      focusable: true,
    };
  }

  private readonly footer: Element = {
    bounds: { left: 0, top: 400, right: 400, bottom: 500 },
    "resource-id": "app:id/more",
    text: "More",
    focusable: true,
  };

  async read(): Promise<FocusScreen> {
    const last = Math.min(this.first + this.visible, this.count);
    const rows = Array.from({ length: last - this.first }, (_, offset) =>
      this.row(this.first + offset),
    );
    const container: Element = { bounds: LIST, "resource-id": "app:id/list", scrollable: true };
    const header: Element = {
      bounds: { left: 0, top: 0, right: 400, bottom: 100 },
      text: "Movies",
    };
    return {
      focused: this.focus === "footer" ? this.footer : this.row(this.focus),
      elements: [header, container, ...rows, ...(this.options.footer ? [this.footer] : [])],
    };
  }

  async press(key: InputKeyName): Promise<{ success: boolean; error?: string }> {
    if (this.failPress) {
      return { success: false, error: this.failPress };
    }
    this.presses.push(key);
    if (key !== "arrow_down" || this.focus === "footer") {
      return { success: true };
    }
    if (this.focus < this.count - 1) {
      this.focus += 1;
      if (this.focus >= this.first + this.visible) {
        this.first += 1;
      }
    } else if (this.options.wrap) {
      this.focus = 0;
      this.first = 0;
    } else if (this.options.footer) {
      this.focus = "footer";
    }
    return { success: true };
  }
}

describe("FocusListAdvance", () => {
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  const advance = (list: FakeTvList) => new FocusListAdvance(list, list, timer);

  test("presses past the last visible row until a hidden row appears", async () => {
    const list = new FakeTvList(6);
    const result = await advance(list).execute({ container: LIST });

    expect(result).toMatchObject({ success: true, status: "revealed", presses: 3 });
    expect(result.revealed).toEqual([expect.stringContaining("Item 3")]);
    expect(list.presses).toEqual(["arrow_down", "arrow_down", "arrow_down"]);
  });

  test("a second advance reveals the next hidden row, not one already seen", async () => {
    const list = new FakeTvList(6);
    await advance(list).execute({ container: LIST });
    const second = await advance(list).execute({ container: LIST });

    expect(second).toMatchObject({ success: true, presses: 1 });
    expect(second.revealed).toEqual([expect.stringContaining("Item 4")]);
  });

  test("a list with no hidden rows is exhausted once focus stops moving", async () => {
    const list = new FakeTvList(3);
    const result = await advance(list).execute({ container: LIST });

    // Two moves to the last row, then two presses that leave focus there.
    expect(result).toMatchObject({ success: false, status: "stuck", presses: 4, revealed: [] });
  });

  test("a list that wraps back to its first row ends on the press bound", async () => {
    const list = new FakeTvList(3, { wrap: true });
    const result = await advance(list).execute({ container: LIST });

    expect(result).toMatchObject({
      success: false,
      status: "max_presses",
      presses: FOCUS_LIST_ADVANCE_MAX_PRESSES,
    });
  });

  test("focus leaving the list below it ends the advance", async () => {
    const list = new FakeTvList(3, { footer: true });
    const result = await advance(list).execute({ container: LIST });

    expect(result).toMatchObject({ success: false, status: "left_list", presses: 3 });
  });

  test("a refused key fails the advance", async () => {
    const list = new FakeTvList(6);
    list.failPress = "device offline";
    await expect(advance(list).execute({ container: LIST })).rejects.toThrow("device offline");
  });

  test("a cancel during the settle ends the advance without waiting it out", async () => {
    const manual = new FakeTimer();
    const list = new FakeTvList(6);
    const controller = new AbortController();
    const outcome = new FocusListAdvance(list, list, manual)
      .execute({ container: LIST, direction: "down", signal: controller.signal })
      .then(
        () => "resolved",
        (error: unknown) => error,
      );
    for (let turn = 0; turn < 20 && manual.getPendingSleepCount() === 0; turn++) {
      await Promise.resolve();
    }
    expect(list.presses).toHaveLength(1);

    controller.abort();

    expect(await outcome).toBeInstanceOf(Error);
    expect(manual.now()).toBe(0);
    expect(list.presses).toHaveLength(1);
  });
});

describe("listAdvanceDirection", () => {
  const cell = (left: number, top: number): Element => ({
    bounds: { left, top, right: left + 100, bottom: top + 100 },
    text: `${left},${top}`,
  });

  test("follows the axis the visible rows are laid out along", async () => {
    // A short vertical list is wider than tall; its stacked rows still say down.
    expect(listAdvanceDirection(LIST, (await new FakeTvList(6).read()).elements)).toBe("down");
    const rail = { left: 0, top: 0, right: 300, bottom: 300 };
    expect(listAdvanceDirection(rail, [cell(0, 100), cell(100, 100), cell(200, 100)])).toBe(
      "right",
    );
  });

  test("falls back to the container's long axis without two rows", () => {
    expect(listAdvanceDirection({ left: 0, top: 0, right: 1920, bottom: 300 })).toBe("right");
    expect(listAdvanceDirection({ left: 0, top: 0, right: 400, bottom: 900 })).toBe("down");
  });
});
