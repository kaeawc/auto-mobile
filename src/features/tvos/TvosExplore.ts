import { ActionableError } from "../../models/ActionableError";
import type { Element } from "../../models";
import type { ExploreResult } from "../navigation/ExploreTypes";
import type { NavigationGraphService } from "../navigation/NavigationGraphService";
import { ScreenFingerprint } from "../navigation/ScreenFingerprint";
import type { NavigationToolCallHandle } from "../../utils/interfaces/NavigationGraph";
import { DefaultElementParser } from "../utility/ElementParser";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { isTvosHierarchy, normalizeTvosHierarchy } from "./TvosHierarchy";
import type { TVRemoteButton } from "./TvosRunnerClient";
import { tvosRunners } from "./TvosRunnerRegistry";

type Direction = "up" | "down" | "left" | "right";
/** Order focus moves are tried in: reading order first, so rows are crawled before columns. */
const DIRECTIONS: readonly Direction[] = ["right", "down", "left", "up"];

export const TVOS_EXPLORE_DEFAULT_MAX_INTERACTIONS = 200;
export const TVOS_EXPLORE_DEFAULT_TIMEOUT_MS = 300_000;
export const TVOS_EXPLORE_MOVE_SETTLE_MS = 150;
export const TVOS_EXPLORE_ACTION_SETTLE_MS = 500;

/** One read of the Apple TV screen: which app is in front, which screen, and what has focus. */
export interface TvosScreenRead {
  packageName: string;
  fingerprint: string;
  focused?: Element;
}

/** The two things the crawl does to the device: read the screen and press a remote button. */
export interface TvosExploreDevice {
  read(signal?: AbortSignal): Promise<TvosScreenRead>;
  press(
    button: Extract<TVRemoteButton, Direction | "select" | "menu">,
    signal?: AbortSignal,
  ): Promise<void>;
}

export type TvosExploreGraph = Pick<
  NavigationGraphService,
  "recordToolCall" | "recordNavigationEvent" | "exportGraphForApp"
>;

export interface TvosExploreOptions {
  maxInteractions?: number;
  timeoutMs?: number;
  packageName?: string;
}

/** Options the shared explore schema offers that a focus crawl cannot honour. */
const UNSUPPORTED_OPTIONS = ["strategy", "resetToHome", "resetInterval", "mode", "dryRun"] as const;

export function assertTvosExploreOptions(
  options: Readonly<Partial<Record<(typeof UNSUPPORTED_OPTIONS)[number], unknown>>>,
): void {
  const refused = UNSUPPORTED_OPTIONS.filter(
    (key) => options[key] !== undefined && options[key] !== false,
  );
  if (refused.length > 0) {
    throw new ActionableError(
      `tvOS explore supports only maxInteractions, timeoutMs and packageName; unsupported: ${refused.join(", ")}.`,
    );
  }
}

interface ScreenState {
  name: string;
  /** Known focus moves on this screen: focus key → direction → focus key it reached. */
  moves: Map<string, Map<Direction, string>>;
  selected: Set<string>;
}

interface CrawlLimits {
  startedAt: number;
  timeoutMs: number;
  maxInteractions: number;
}

type NextStep = { kind: "select" } | { kind: "move"; direction: Direction } | { kind: "back" };

function focusKey(element: Element | undefined): string {
  if (!element) {
    return "none";
  }
  const { left, top, right, bottom } = element.bounds;
  return JSON.stringify([
    element["resource-id"],
    element.text,
    element.className,
    left,
    top,
    right,
    bottom,
  ]);
}

interface ReplayCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * The replayable public call a select on `focused` stands for. The identifier wins over the text:
 * two controls can share a label but not, in a well-formed app, an identifier. A control with
 * neither gets no call: a bare `select` would replay whichever control has focus, so two such
 * controls would record the same call for different destinations. Its transition is still
 * recorded, and replay refuses it as having no recorded action rather than open the wrong screen.
 */
function selectCall(focused: Element | undefined): ReplayCall | undefined {
  if (focused?.["resource-id"]) {
    return {
      tool: "tapOn",
      args: { action: "tap", selector: { elementId: focused["resource-id"] } },
    };
  }
  if (focused?.text) {
    return { tool: "tapOn", args: { action: "tap", selector: { text: focused.text } } };
  }
  return undefined;
}

/** The first move toward the nearest focus position that is unselected or has an untried move. */
export function nextFocusStep(
  screen: Pick<ScreenState, "moves" | "selected">,
  from: string,
): NextStep {
  if (!screen.selected.has(from)) {
    return { kind: "select" };
  }
  const firstMove = new Map<string, Direction | undefined>([[from, undefined]]);
  const queue = [from];
  for (let index = 0; index < queue.length; index++) {
    const key = queue[index]!;
    const known = screen.moves.get(key);
    const untried = DIRECTIONS.find((direction) => !known?.has(direction));
    const goal = !screen.selected.has(key) || untried !== undefined;
    if (goal) {
      return { kind: "move", direction: firstMove.get(key) ?? untried! };
    }
    for (const [direction, next] of known ?? []) {
      if (!firstMove.has(next)) {
        firstMove.set(next, firstMove.get(key) ?? direction);
        queue.push(next);
      }
    }
  }
  return { kind: "back" };
}

/**
 * Crawls a tvOS app with the Siri Remote: selects every focus position it can reach on a screen,
 * re-reading focus after every move, and records each screen a select or menu press reaches in
 * the navigation graph, with the call that replays it.
 */
export class TvosExplore {
  private readonly screens = new Map<string, ScreenState>();
  private readonly stack: ScreenState[] = [];
  private readonly path: string[] = [];
  private interactions = 0;
  private edges = 0;
  private sequence = 0;

  constructor(
    private readonly device: TvosExploreDevice,
    private readonly graph: TvosExploreGraph,
    private readonly deviceId: string,
    private readonly timer: Timer = defaultTimer,
  ) {}

  async execute(options: TvosExploreOptions, signal?: AbortSignal): Promise<ExploreResult> {
    const startedAt = this.timer.now();
    const read = await this.device.read(signal);
    const appId = options.packageName ?? read.packageName;
    if (read.packageName !== appId) {
      throw new ActionableError(
        `${appId} is not in the foreground on the Apple TV (found ${read.packageName}); launch it with launchApp before exploring.`,
      );
    }
    const limits: CrawlLimits = {
      startedAt,
      timeoutMs: options.timeoutMs ?? TVOS_EXPLORE_DEFAULT_TIMEOUT_MS,
      maxInteractions: options.maxInteractions ?? TVOS_EXPLORE_DEFAULT_MAX_INTERACTIONS,
    };
    let stopReason: string | undefined;
    try {
      stopReason = await this.crawl(read, appId, limits, signal);
    } catch (error) {
      if (!signal?.aborted) {
        throw error;
      }
    }
    // The crawl returns no reason only when the signal stopped it.
    const cancelled = stopReason === undefined;
    return this.result(appId, startedAt, stopReason ?? "Operation cancelled", cancelled);
  }

  /** Walk the app until a limit or the root screen is exhausted; undefined when cancelled. */
  private async crawl(
    first: TvosScreenRead,
    appId: string,
    limits: CrawlLimits,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    let read = first;
    let current = await this.arrive(this.screenFor(read.fingerprint), appId, undefined);
    while (!signal?.aborted) {
      const budget = this.budgetStop(limits);
      if (budget !== undefined) {
        return budget;
      }
      const step = nextFocusStep(current, focusKey(read.focused));
      if (step.kind === "move") {
        read = await this.move(current, read, step.direction, signal);
        continue;
      }
      const outcome =
        step.kind === "select"
          ? await this.select(current, read, appId, signal)
          : await this.back(current, read, appId, signal);
      if (outcome.stopReason !== undefined) {
        return outcome.stopReason;
      }
      read = outcome.read;
      current = outcome.screen ?? current;
    }
    return undefined;
  }

  private budgetStop({ startedAt, timeoutMs, maxInteractions }: CrawlLimits): string | undefined {
    if (this.interactions >= maxInteractions) {
      return `Reached maxInteractions (${maxInteractions})`;
    }
    if (this.timer.now() - startedAt >= timeoutMs) {
      return `Reached timeoutMs (${timeoutMs})`;
    }
    return undefined;
  }

  private screenFor(fingerprint: string): ScreenState {
    const known = this.screens.get(fingerprint);
    if (known) {
      return known;
    }
    const screen: ScreenState = {
      name: `tvos-${fingerprint.slice(0, 12)}`,
      moves: new Map(),
      selected: new Set(),
    };
    this.screens.set(fingerprint, screen);
    return screen;
  }

  /** Record that the app is now on `screen`; the pending tool call, if any, labels the edge. */
  private async arrive(
    screen: ScreenState,
    appId: string,
    from: ScreenState | undefined,
  ): Promise<ScreenState> {
    await this.graph.recordNavigationEvent({
      destination: screen.name,
      source: from?.name ?? "",
      arguments: {},
      metadata: { platform: "tvos" },
      sequenceNumber: this.sequence++,
      applicationId: appId,
      deviceId: this.deviceId,
    });
    if (from && from !== screen) {
      this.edges++;
    }
    this.path.push(screen.name);
    return screen;
  }

  private async move(
    screen: ScreenState,
    before: TvosScreenRead,
    direction: Direction,
    signal?: AbortSignal,
  ): Promise<TvosScreenRead> {
    await this.device.press(direction, signal);
    // The focus engine remembers the last item per row, so geometry cannot predict the result.
    const after = await this.device.read(signal);
    const from = focusKey(before.focused);
    const known = screen.moves.get(from) ?? new Map<Direction, string>();
    known.set(direction, focusKey(after.focused));
    screen.moves.set(from, known);
    // A move that scrolls changes the fingerprint without leaving the screen.
    if (!this.screens.has(after.fingerprint)) {
      this.screens.set(after.fingerprint, screen);
    }
    return after;
  }

  private async select(
    screen: ScreenState,
    before: TvosScreenRead,
    appId: string,
    signal?: AbortSignal,
  ): Promise<{ read: TvosScreenRead; screen?: ScreenState; stopReason?: string }> {
    screen.selected.add(focusKey(before.focused));
    const call = selectCall(before.focused);
    const after = await this.recorded(call, "select", signal);
    if (after.read.packageName !== appId) {
      return this.returnToApp(after.read, appId, after.withdraw, signal);
    }
    if (this.screens.get(after.read.fingerprint) === screen) {
      after.withdraw();
      return { read: after.read };
    }
    this.stack.push(screen);
    const next = await this.arrive(this.screenFor(after.read.fingerprint), appId, screen);
    return { read: after.read, screen: next };
  }

  private async back(
    from: ScreenState,
    before: TvosScreenRead,
    appId: string,
    signal?: AbortSignal,
  ): Promise<{ read: TvosScreenRead; screen?: ScreenState; stopReason?: string }> {
    const parent = this.stack.pop();
    if (!parent) {
      return { read: before, stopReason: "No unexplored focus on the root screen" };
    }
    const after = await this.recorded(
      { tool: "pressButton", args: { button: "menu" } },
      "menu",
      signal,
    );
    if (after.read.packageName !== appId) {
      after.withdraw();
      return { read: after.read, stopReason: `Left target app (${after.read.packageName})` };
    }
    if (!this.screens.has(after.read.fingerprint)) {
      this.screens.set(after.read.fingerprint, parent);
    }
    const reached = this.screens.get(after.read.fingerprint)!;
    return { read: after.read, screen: await this.arrive(reached, appId, from) };
  }

  /** A select that left the app: press menu once to come back, else stop. */
  private async returnToApp(
    left: TvosScreenRead,
    appId: string,
    withdraw: () => void,
    signal?: AbortSignal,
  ): Promise<{ read: TvosScreenRead; stopReason?: string }> {
    withdraw();
    await this.device.press("menu", signal);
    this.interactions++;
    const read = await this.device.read(signal);
    return read.packageName === appId
      ? { read }
      : { read, stopReason: `Left target app (${left.packageName})` };
  }

  /** Press `button` while the graph holds the call that replays it, then re-read the screen. */
  private async recorded(
    call: ReplayCall | undefined,
    button: "select" | "menu",
    signal?: AbortSignal,
  ): Promise<{ read: TvosScreenRead; withdraw: () => void }> {
    // No call to record: there is nothing to withdraw either.
    const handle: NavigationToolCallHandle = call
      ? this.graph.recordToolCall(call.tool, call.args, undefined, this.deviceId)
      : () => undefined;
    try {
      handle.markDispatched?.();
      await this.device.press(button, signal);
      this.interactions++;
      return { read: await this.device.read(signal), withdraw: () => handle() };
    } catch (error) {
      handle();
      throw error;
    }
  }

  private async result(
    appId: string,
    startedAt: number,
    stopReason: string,
    cancelled: boolean,
  ): Promise<ExploreResult> {
    const screens = new Set(this.screens.values());
    const explored = [...screens].filter((screen) => screen.selected.size > 0).length;
    return {
      success: true,
      ...(cancelled ? { cancelled: true } : {}),
      interactionsPerformed: this.interactions,
      screensDiscovered: screens.size,
      edgesAdded: this.edges,
      navigationGraph: await this.graph.exportGraphForApp(appId),
      explorationPath: this.path,
      coverage: {
        totalScreens: screens.size,
        exploredScreens: explored,
        percentage: screens.size === 0 ? 0 : Math.round((explored / screens.size) * 100),
      },
      durationMs: this.timer.now() - startedAt,
      stopReason,
    };
  }
}

const parser = new DefaultElementParser();

/** Reads and presses through the device's connected tvOS runner. */
export function createTvosExploreDevice(
  deviceId: string,
  timer: Timer = defaultTimer,
): TvosExploreDevice {
  return {
    read: async (signal) => {
      const raw = await tvosRunners.require(deviceId).hierarchy(signal);
      if (!isTvosHierarchy(raw)) {
        throw new ActionableError("Invalid tvOS hierarchy; reconnect the runner.");
      }
      const focused = parser
        .flattenViewHierarchy(normalizeTvosHierarchy(raw))
        .map(({ element }) => element)
        .find((element) => element.focused === "true");
      return {
        packageName: raw.packageName,
        fingerprint: ScreenFingerprint.compute(raw).hash,
        ...(focused ? { focused } : {}),
      };
    },
    press: async (button, signal) => {
      await tvosRunners
        .require(deviceId)
        .request({ type: "request_press_button", action: button }, signal);
      await timer.sleep(
        button === "select" || button === "menu"
          ? TVOS_EXPLORE_ACTION_SETTLE_MS
          : TVOS_EXPLORE_MOVE_SETTLE_MS,
      );
    },
  };
}
