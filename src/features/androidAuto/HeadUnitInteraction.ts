import { ActionableError } from "../../models/ActionableError";
import type { CarAppProjectedTemplates } from "../../models/CarAppTemplates";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type { DesktopHeadUnitConsole } from "./DesktopHeadUnit";

/**
 * Actions on the projected head unit (#17842). The phone's accessibility tree, `activeWindow` and
 * `gfxinfo` stay still while Android Auto projects, so input goes through the DHU console and the
 * before/after reads come from the projected apps' Car App Library template stacks.
 */

/** The `display` value that targets the projected head unit instead of a phone panel. */
export const HEAD_UNIT_DISPLAY = "headUnit";

/** The projected apps' template stacks, read now. */
export interface HeadUnitTemplateSource {
  read(): Promise<CarAppProjectedTemplates | undefined>;
}

export interface HeadUnitIdleTiming {
  /** Delay between template reads. */
  pollMs: number;
  /** A screen that still matches the one before the input counts as settled only after this long. */
  unchangedSettleMs: number;
  /** The wait ends here whether or not two reads agreed. */
  timeoutMs: number;
}

export const DEFAULT_HEAD_UNIT_IDLE_TIMING: HeadUnitIdleTiming = {
  pollMs: 250,
  unchangedSettleMs: 1_000,
  timeoutMs: 3_000,
};

/** One projected session's top screen. */
export interface HeadUnitScreen {
  packageName: string;
  carSessionId: string;
  screenClass: string;
  templateType?: string;
  title?: string;
  /** Screens on the session's stack, root included. */
  depth: number;
  loading?: true;
}

export type HeadUnitEffectBasis =
  | "carAppTemplates changed"
  | "carAppTemplates unchanged"
  | "no template data";

export interface HeadUnitEffect {
  /** Absent when either read had no template data, so a change cannot be told either way. */
  screenChanged?: boolean;
  basis: HeadUnitEffectBasis;
}

export interface HeadUnitIdle {
  basis: "carAppTemplates" | "none";
  /** Two consecutive reads agreed, with no template loading, before the timeout. */
  stable: boolean;
  waitedMs: number;
}

export interface HeadUnitInteractionResult {
  display: typeof HEAD_UNIT_DISPLAY;
  commands: string[];
  effect: HeadUnitEffect;
  idle: HeadUnitIdle;
  before?: HeadUnitScreen[];
  after?: HeadUnitScreen[];
}

/** pressButton buttons and the DHU console commands they map to. */
const BUTTON_COMMANDS: Readonly<Record<string, string>> = {
  up: "dpad up",
  down: "dpad down",
  left: "dpad left",
  right: "dpad right",
  select: "dpad click",
  back: "dpad back",
  home: "keycode home",
  playPause: "keycode media_play_pause",
  next: "keycode media_next",
  previous: "keycode media_previous",
  rotary_rotate_cw: "dpad rotate right",
  rotary_rotate_ccw: "dpad rotate left",
  rotary_nudge_up: "dpad up",
  rotary_nudge_down: "dpad down",
  rotary_nudge_left: "dpad left",
  rotary_nudge_right: "dpad right",
  rotary_select: "dpad click",
};

const REPEATABLE_BUTTONS = new Set(["rotary_rotate_cw", "rotary_rotate_ccw"]);

export const HEAD_UNIT_BUTTONS = Object.keys(BUTTON_COMMANDS);

/** The console commands for one pressButton on the head unit. */
export function headUnitButtonCommands(
  button: string,
  options: { steps?: number; durationMs?: number } = {},
): string[] {
  const command = BUTTON_COMMANDS[button];
  if (!command) {
    throw new ActionableError(
      `pressButton ${button} has no head unit equivalent. With display "${HEAD_UNIT_DISPLAY}", use one of: ${HEAD_UNIT_BUTTONS.join(", ")}.`,
    );
  }
  if (options.durationMs !== undefined) {
    throw new ActionableError(
      `durationMs is not supported with display "${HEAD_UNIT_DISPLAY}": the DHU console has no long press.`,
    );
  }
  const steps = options.steps ?? 1;
  if (steps !== 1 && !REPEATABLE_BUTTONS.has(button)) {
    throw new ActionableError(
      `steps applies only to rotary_rotate_cw and rotary_rotate_ccw, not ${button}.`,
    );
  }
  return Array.from({ length: steps }, () => command);
}

/** The console command for a tapAt on the head unit; `x` and `y` are head-unit pixels. */
export function headUnitTapCommand(x: number, y: number): string {
  for (const [axis, value] of [
    ["x", x],
    ["y", y],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new ActionableError(
        `tapAt ${axis} must be a non-negative head-unit pixel with display "${HEAD_UNIT_DISPLAY}", got ${value}.`,
      );
    }
  }
  return `tap ${Math.round(x)} ${Math.round(y)}`;
}

/** Every projected session's top screen, ordered as the block orders apps and sessions. */
export function headUnitScreens(templates: CarAppProjectedTemplates): HeadUnitScreen[] {
  return templates.projected.flatMap((app) =>
    app.sessions.flatMap((session) => {
      const top = session.screens.at(-1);
      if (!top) {
        return [];
      }
      const template = top.template;
      return [
        {
          packageName: app.packageName,
          carSessionId: session.id,
          screenClass: top.screenClass,
          ...(template ? { templateType: template.type } : {}),
          ...(template?.title !== undefined ? { title: template.title } : {}),
          depth: session.screens.length,
          // A TabTemplate's bar can be loaded while its active tab's content still loads.
          ...(template?.loading || template?.tabContent?.loading ? { loading: true as const } : {}),
        },
      ];
    }),
  );
}

function screensKey(screens: readonly HeadUnitScreen[]): string {
  return JSON.stringify(
    screens.map(({ packageName, carSessionId, screenClass, templateType, title, depth }) => [
      packageName,
      carSessionId,
      screenClass,
      templateType ?? null,
      title ?? null,
      depth,
    ]),
  );
}

/** Compares two template reads: the top screen class, template type and title, and stack depth. */
export function deriveHeadUnitEffect(
  before: readonly HeadUnitScreen[] | undefined,
  after: readonly HeadUnitScreen[] | undefined,
): HeadUnitEffect {
  if (!before || !after) {
    return { basis: "no template data" };
  }
  const changed = screensKey(before) !== screensKey(after);
  return {
    screenChanged: changed,
    basis: changed ? "carAppTemplates changed" : "carAppTemplates unchanged",
  };
}

/**
 * Two consecutive reads agree and neither is still loading. A read that matches the screen before
 * the input settles only once `unchangedWindowOver`, so a slow push is not taken for a no-op.
 */
function isSettled(
  current: readonly HeadUnitScreen[] | undefined,
  previous: readonly HeadUnitScreen[] | undefined,
  beforeKey: string | undefined,
  unchangedWindowOver: boolean,
): current is HeadUnitScreen[] {
  if (!current || !previous || [...current, ...previous].some((screen) => screen.loading)) {
    return false;
  }
  const key = screensKey(current);
  return key === screensKey(previous) && (key !== beforeKey || unchangedWindowOver);
}

/**
 * Sends console commands to the daemon's running DHU, then polls the projected templates until two
 * consecutive reads agree. It never starts or stops the DHU.
 */
export class HeadUnitInteraction {
  constructor(
    private readonly dhuConsole: DesktopHeadUnitConsole,
    private readonly templates: HeadUnitTemplateSource,
    private readonly timer: Timer,
    private readonly timing: HeadUnitIdleTiming = DEFAULT_HEAD_UNIT_IDLE_TIMING,
  ) {}

  async run(commands: readonly string[], signal?: AbortSignal): Promise<HeadUnitInteractionResult> {
    signal?.throwIfAborted();
    if (!this.dhuConsole.isRunning()) {
      throw new ActionableError(
        "The Desktop Head Unit is not running. Start it with startDevice androidAuto.headUnit, then retry.",
      );
    }
    const before = await this.readScreens();
    signal?.throwIfAborted();
    commands.forEach((command) => this.dhuConsole.sendCommand(command));
    const { idle, after } = await this.waitForIdle(before, signal);
    return {
      display: HEAD_UNIT_DISPLAY,
      commands: [...commands],
      effect: deriveHeadUnitEffect(before, after),
      idle,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    };
  }

  private async waitForIdle(
    before: HeadUnitScreen[] | undefined,
    signal?: AbortSignal,
  ): Promise<{ idle: HeadUnitIdle; after: HeadUnitScreen[] | undefined }> {
    const { pollMs, unchangedSettleMs, timeoutMs } = this.timing;
    const start = this.timer.now();
    const elapsed = () => this.timer.now() - start;
    const beforeKey = before ? screensKey(before) : undefined;
    let previous: HeadUnitScreen[] | undefined;
    let sawData = false;
    while (elapsed() < timeoutMs) {
      await this.timer.sleep(pollMs);
      signal?.throwIfAborted();
      const current = await this.readScreens();
      sawData ||= current !== undefined;
      if (isSettled(current, previous, beforeKey, elapsed() >= unchangedSettleMs)) {
        return {
          idle: { basis: "carAppTemplates", stable: true, waitedMs: elapsed() },
          after: current,
        };
      }
      if (!current && !sawData && !before) {
        // Nothing to poll: no projected app answers the template route.
        return { idle: { basis: "none", stable: false, waitedMs: elapsed() }, after: undefined };
      }
      previous = current;
    }
    return {
      idle: { basis: sawData ? "carAppTemplates" : "none", stable: false, waitedMs: elapsed() },
      after: previous,
    };
  }

  private async readScreens(): Promise<HeadUnitScreen[] | undefined> {
    try {
      const templates = await this.templates.read();
      const failed = templates?.projected.find((app) => app.error !== undefined);
      if (failed) {
        // The SDK answers a failed stack read (main_thread_timeout) with an error and no sessions:
        // that is no evidence of the screen, not an empty one.
        logger.debug(`[AndroidAuto] ${failed.packageName} template read failed: ${failed.error}`);
        return undefined;
      }
      return templates ? headUnitScreens(templates) : undefined;
    } catch (error) {
      logger.warn(`[AndroidAuto] head unit template read failed: ${errorMessage(error)}`, error);
      return undefined;
    }
  }
}
