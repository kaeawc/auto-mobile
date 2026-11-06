import type { Element } from "../../src/models";
import type {
  TvosExploreDevice,
  TvosExploreGraph,
  TvosScreenRead,
} from "../../src/features/tvos/TvosExplore";
import type {
  ExportedGraph,
  IncomingNavigationEvent,
  NavigationToolCallHandle,
} from "../../src/utils/interfaces/NavigationGraph";

export interface FakeTvItem {
  id: string;
  text?: string;
  col: number;
  row: number;
  /** True for a control the hierarchy exposes without an identifier. */
  anonymous?: boolean;
  /** Screen a select opens, or "leave" to put another app in front. */
  opens?: string;
}

/** A remote-driven app: screens of grid items, a back stack, and per-screen remembered focus. */
export class FakeTvosExploreApp implements TvosExploreDevice {
  readonly presses: string[] = [];
  reads = 0;
  packageName: string;
  private readonly stack: string[];
  private readonly focus = new Map<string, string>();
  /** Called after every press, for tests that change the app mid-crawl. */
  afterPress?: (button: string) => void;

  constructor(
    readonly screens: Record<string, FakeTvItem[]>,
    start: string,
    readonly appId = "com.example.tv",
  ) {
    this.packageName = appId;
    this.stack = [start];
  }

  get screen(): string {
    return this.stack[this.stack.length - 1]!;
  }

  private focused(): FakeTvItem | undefined {
    const items = this.screens[this.screen] ?? [];
    const id = this.focus.get(this.screen) ?? items[0]?.id;
    return items.find((item) => item.id === id);
  }

  async read(signal?: AbortSignal): Promise<TvosScreenRead> {
    signal?.throwIfAborted();
    this.reads++;
    const item = this.packageName === this.appId ? this.focused() : undefined;
    const focused: Element | undefined = item
      ? {
          bounds: {
            left: item.col * 100,
            top: item.row * 100,
            right: item.col * 100 + 90,
            bottom: item.row * 100 + 90,
          },
          ...(item.anonymous ? {} : { "resource-id": item.id }),
          ...(item.text ? { text: item.text } : {}),
          focused: "true",
        }
      : undefined;
    return {
      packageName: this.packageName,
      fingerprint: this.packageName === this.appId ? `fp-${this.screen}` : "fp-home",
      ...(focused ? { focused } : {}),
    };
  }

  async press(button: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.presses.push(button);
    if (this.packageName !== this.appId) {
      if (button === "menu") {
        this.packageName = this.appId;
      }
    } else if (button === "select") {
      this.select();
    } else if (button === "menu") {
      this.back();
    } else {
      this.move(button);
    }
    this.afterPress?.(button);
  }

  private select(): void {
    const target = this.focused()?.opens;
    if (target === "leave") {
      this.packageName = "com.apple.TVSettings";
    } else if (target) {
      this.stack.push(target);
    }
  }

  private back(): void {
    if (this.stack.length > 1) {
      this.stack.pop();
    } else {
      this.packageName = "com.apple.HeadBoard";
    }
  }

  private move(direction: string): void {
    const from = this.focused();
    if (!from) {
      return;
    }
    const horizontal = direction === "left" || direction === "right";
    const sign = direction === "right" || direction === "down" ? 1 : -1;
    const along = (item: FakeTvItem): number => (horizontal ? item.col : item.row);
    const across = (item: FakeTvItem): number => (horizontal ? item.row : item.col);
    const next = (this.screens[this.screen] ?? [])
      .filter((item) => across(item) === across(from) && (along(item) - along(from)) * sign > 0)
      .sort((a, b) => (along(a) - along(b)) * sign)[0];
    if (next) {
      this.focus.set(this.screen, next.id);
    }
  }
}

export interface RecordedCall {
  tool: string;
  args: Record<string, unknown>;
  withdrawn: boolean;
  dispatched: boolean;
}

/** Records the tool calls and navigation events the crawl writes. */
export class RecordingTvosExploreGraph implements TvosExploreGraph {
  readonly calls: RecordedCall[] = [];
  readonly events: IncomingNavigationEvent[] = [];
  /** The call in force when each event was recorded: the edge label it would get. */
  readonly edgeCalls: Array<RecordedCall | undefined> = [];

  recordToolCall(toolName: string, args: Record<string, unknown>): NavigationToolCallHandle {
    const call: RecordedCall = { tool: toolName, args, withdrawn: false, dispatched: false };
    this.calls.push(call);
    const handle: NavigationToolCallHandle = Object.assign(
      () => {
        call.withdrawn = true;
      },
      {
        markDispatched: () => {
          call.dispatched = true;
        },
      },
    );
    return handle;
  }

  async recordNavigationEvent(event: IncomingNavigationEvent): Promise<void> {
    const pending = this.calls.at(-1);
    this.edgeCalls.push(pending && !pending.withdrawn ? pending : undefined);
    if (pending) {
      // The real manager consumes the call that labelled an edge.
      pending.withdrawn = true;
    }
    this.events.push(event);
  }

  async exportGraphForApp(appId: string | null): Promise<ExportedGraph> {
    return { appId, nodes: [], edges: [], currentScreen: this.events.at(-1)?.destination ?? null };
  }
}
