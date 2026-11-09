import { FakeTvosRunnerClient } from "./FakeTvosRunnerClient";
import type { TvosCommand, TvosRunnerClient } from "../../src/features/tvos/TvosRunnerClient";
import type { TvosHierarchy } from "../../src/features/tvos/TvosHierarchy";

const SCREEN_WIDTH = 1920;
const SCREEN_HEIGHT = 1080;
const ITEM_WIDTH = 400;
const ITEM_GAP = 40;
const ROW_HEIGHT = 300;

export interface ScrollingRowOptions {
  /** Item count in each row, top to bottom. */
  rows: number[];
  /**
   * How far past the screen edges cells stay in the hierarchy, in points. Zero mimics a collection
   * view that has not loaded the cells of its next viewport yet.
   */
  prefetch: number;
  /** Cell label; defaults to `Item <row>-<column>`. */
  label?: (row: number, column: number) => string;
  /** False leaves every cell without an accessibility identifier. */
  identifiers?: boolean;
}

/**
 * Rows of cells that scroll horizontally as focus moves, like a tvOS shelf. Each row keeps its own
 * scroll offset and remembered focus column; a press past an edge changes nothing.
 */
export class ScrollingRowFakeTvosRunnerClient extends FakeTvosRunnerClient {
  row = 0;
  private readonly columns: number[];
  private readonly offsets: number[];

  constructor(private readonly options: ScrollingRowOptions) {
    super(ScrollingRowFakeTvosRunnerClient.render(options, 0, [], []));
    this.columns = options.rows.map(() => 0);
    this.offsets = options.rows.map(() => 0);
  }

  get focusedId(): string {
    return itemId(this.row, this.columns[this.row]!);
  }

  override async request(
    command: TvosCommand,
    signal?: AbortSignal,
    options?: Parameters<TvosRunnerClient["request"]>[2],
  ): Promise<unknown> {
    await super.request(command, signal, options);
    if (command.type === "request_press_button") {
      this.move(command.action);
      return undefined;
    }
    return command.type === "request_hierarchy" ? this.current() : undefined;
  }

  override async hierarchy(signal?: AbortSignal): Promise<TvosHierarchy> {
    await super.request({ type: "request_hierarchy" }, signal);
    return this.current();
  }

  private current(): TvosHierarchy {
    return ScrollingRowFakeTvosRunnerClient.render(
      this.options,
      this.row,
      this.columns,
      this.offsets,
    );
  }

  private move(action: string): void {
    const count = this.options.rows[this.row]!;
    const column = this.columns[this.row]!;
    if (action === "right" && column + 1 < count) {
      this.columns[this.row] = column + 1;
    } else if (action === "left" && column > 0) {
      this.columns[this.row] = column - 1;
    } else if (action === "down" && this.row + 1 < this.options.rows.length) {
      this.row++;
    } else if (action === "up" && this.row > 0) {
      this.row--;
    }
    const left = this.columns[this.row]! * (ITEM_WIDTH + ITEM_GAP);
    const offset = this.offsets[this.row]!;
    if (left + ITEM_WIDTH - offset > SCREEN_WIDTH) {
      this.offsets[this.row] = left + ITEM_WIDTH - SCREEN_WIDTH;
    } else if (left < offset) {
      this.offsets[this.row] = left;
    }
  }

  private static render(
    options: ScrollingRowOptions,
    focusRow: number,
    columns: number[],
    offsets: number[],
  ): TvosHierarchy {
    const cells = options.rows.flatMap((count, row) =>
      Array.from({ length: count }, (_, column) => {
        const left = column * (ITEM_WIDTH + ITEM_GAP) - (offsets[row] ?? 0);
        return { row, column, left, right: left + ITEM_WIDTH };
      }).filter(
        ({ left, right }) => right > -options.prefetch && left < SCREEN_WIDTH + options.prefetch,
      ),
    );
    return {
      packageName: "com.example.tv",
      updatedAt: 0,
      screenWidth: SCREEN_WIDTH,
      screenHeight: SCREEN_HEIGHT,
      hierarchy: {
        className: "1",
        bounds: { left: 0, top: 0, right: SCREEN_WIDTH, bottom: SCREEN_HEIGHT },
        node: cells.map(({ row, column, left, right }) => ({
          className: "9",
          ...(options.identifiers === false ? {} : { "resource-id": itemId(row, column) }),
          text: options.label?.(row, column) ?? `Item ${row}-${column}`,
          enabled: "true",
          focused: row === focusRow && column === (columns[row] ?? 0) ? "true" : "false",
          bounds: { left, top: row * ROW_HEIGHT, right, bottom: row * ROW_HEIGHT + 260 },
        })),
      },
    };
  }
}

export function itemId(row: number, column: number): string {
  return `item-${row}-${column}`;
}
