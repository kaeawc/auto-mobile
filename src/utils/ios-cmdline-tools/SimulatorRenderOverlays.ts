import { z } from "zod/v4";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { commandFailureDetails } from "../CommandError";
import { errorMessage } from "../describeUnknownError";
import { DefaultHostCommandExecutor, type HostCommandExecutor } from "../HostCommandExecutor";
import { resolveDeveloperDirectory } from "./SimulatorBacklight";

/**
 * Core Animation render overlays the Simulator's Debug menu offers (#19016), keyed by the
 * option id `-[SimDevice setCADebugOption:enabled:]` takes. Ids were mapped by turning each on
 * over a screen and diffing screenshots; ids with no visible effect are left out.
 */
export const RENDER_OVERLAY_OPTION_IDS = {
  flashUpdatedRegions: 0,
  copiedImages: 1,
  blendedLayers: 2,
  offscreenRendered: 17,
  cacheHits: 19,
  misalignedImages: 20,
} as const;

export type RenderOverlay = keyof typeof RENDER_OVERLAY_OPTION_IDS;

export const RENDER_OVERLAYS = Object.keys(RENDER_OVERLAY_OPTION_IDS) as RenderOverlay[];

export type RenderOverlayValues = Partial<Record<RenderOverlay, boolean>>;

/** Every overlay's state before and after a write. */
export interface RenderOverlayChange {
  previous: Record<RenderOverlay, boolean>;
  applied: Record<RenderOverlay, boolean>;
}

/** Reads and toggles the render overlays of one booted or shut-down Simulator. */
export interface SimulatorRenderOverlayControl {
  read(udid: string, signal?: AbortSignal): Promise<Record<RenderOverlay, boolean>>;
  set(
    udid: string,
    values: RenderOverlayValues,
    signal?: AbortSignal,
  ): Promise<RenderOverlayChange>;
}

export function isRenderOverlay(value: string): value is RenderOverlay {
  return Object.hasOwn(RENDER_OVERLAY_OPTION_IDS, value);
}

/** `SimDeviceState.booted`. */
const SIM_DEVICE_STATE_BOOTED = 3;
const NOT_BOOTED_MARKER = "automobile-simulator-not-booted";

/**
 * Loads CoreSimulator into an `osascript` JavaScript process, so a private-API crash or Xcode
 * mismatch takes down only that process. argv: udid, the developer directory, then option id / 0|1
 * pairs to write; a write to a Simulator that is not booted fails with {@link NOT_BOOTED_MARKER}.
 * Prints every mapped option's state before and after the writes as JSON.
 */
const JXA_SCRIPT = `
ObjC.import('Foundation');
function run(argv) {
  const ids = ${JSON.stringify(Object.values(RENDER_OVERLAY_OPTION_IDS))};
  ObjC.unwrap($.NSBundle.bundleWithPath('/Library/Developer/PrivateFrameworks/CoreSimulator.framework').load);
  const contextClass = $.NSClassFromString('SimServiceContext');
  if (contextClass.isNil()) throw new Error('CoreSimulator SimServiceContext is unavailable');
  const dir = argv[1];
  const context = contextClass.sharedServiceContextForDeveloperDirError($(dir), null);
  if (context.isNil()) throw new Error('CoreSimulator service context is unavailable for ' + dir);
  const set = context.defaultDeviceSetWithError(null);
  if (set.isNil()) throw new Error('CoreSimulator default device set is unavailable');
  const uuid = $.NSUUID.alloc.initWithUUIDString($(argv[0]));
  const device = uuid.isNil() ? uuid : set.devicesByUDID.objectForKey(uuid);
  if (device.isNil()) throw new Error('Simulator ' + argv[0] + ' was not found in the default device set');
  if (!device.respondsToSelector('setCADebugOption:enabled:') || !device.respondsToSelector('getCADebugOption:')) {
    throw new Error('SimDevice CA debug options are unavailable in this CoreSimulator');
  }
  if (argv.length > 2 && Number(device.state) !== ${SIM_DEVICE_STATE_BOOTED}) {
    throw new Error('${NOT_BOOTED_MARKER}');
  }
  const read = () => Object.fromEntries(ids.map((id) => [String(id), !!device.getCADebugOption(id)]));
  const previous = read();
  for (let i = 2; i + 1 < argv.length; i += 2) {
    device.setCADebugOptionEnabled(Number(argv[i]), argv[i + 1] === '1');
  }
  return JSON.stringify({ previous: previous, applied: read() });
}
`;

const optionStatesSchema = z.record(z.string(), z.boolean());
const scriptOutputSchema = z.object({ previous: optionStatesSchema, applied: optionStatesSchema });

const OSASCRIPT_TIMEOUT_MS = 15_000;

/** {@link SimulatorRenderOverlayControl} through CoreSimulator's SimDevice in `osascript`. */
export class OsascriptSimulatorRenderOverlayControl implements SimulatorRenderOverlayControl {
  constructor(
    private readonly host: HostCommandExecutor = new DefaultHostCommandExecutor(),
    private readonly developerDirectory: () => Promise<string> = () => resolveDeveloperDirectory(),
  ) {}

  async read(udid: string, signal?: AbortSignal): Promise<Record<RenderOverlay, boolean>> {
    return (await this.run(udid, {}, signal)).applied;
  }

  set(
    udid: string,
    values: RenderOverlayValues,
    signal?: AbortSignal,
  ): Promise<RenderOverlayChange> {
    return this.run(udid, values, signal);
  }

  private async run(
    udid: string,
    values: RenderOverlayValues,
    signal?: AbortSignal,
  ): Promise<RenderOverlayChange> {
    const writes = RENDER_OVERLAYS.filter((overlay) => values[overlay] !== undefined).flatMap(
      (overlay) => [String(RENDER_OVERLAY_OPTION_IDS[overlay]), values[overlay] ? "1" : "0"],
    );
    let stdout: string;
    try {
      const result = await this.host.executeCommand(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", JXA_SCRIPT, udid, await this.developerDirectory(), ...writes],
        { timeoutMs: OSASCRIPT_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      );
      stdout = result.stdout;
    } catch (error) {
      // The failure message would quote the whole script; osascript's stderr names the cause.
      const stderr = commandFailureDetails(error).stderr.trim();
      if (stderr.includes(NOT_BOOTED_MARKER)) {
        throw new ActionableError(
          `Simulator ${udid} is not booted, so its render overlays cannot be changed. Boot it ` +
            "first; overlays are off after every boot.",
          { cause: error },
        );
      }
      throw new ActionableError(
        `Could not reach the Core Animation render overlays of Simulator ${udid} through ` +
          `CoreSimulator: ${stderr || errorMessage(error)}`,
        { cause: error },
      );
    }
    return parseRenderOverlayOutput(stdout);
  }
}

/** Map the script's option-id JSON back to overlay names; a missing id fails the parse. */
export function parseRenderOverlayOutput(stdout: string): RenderOverlayChange {
  let parsed: z.infer<typeof scriptOutputSchema>;
  try {
    parsed = scriptOutputSchema.parse(JSON.parse(stdout.trim()));
  } catch (error) {
    throw toActionableError(error, "CoreSimulator returned unreadable render overlay state");
  }
  return { previous: byOverlay(parsed.previous), applied: byOverlay(parsed.applied) };
}

function byOverlay(states: Record<string, boolean>): Record<RenderOverlay, boolean> {
  return Object.fromEntries(
    RENDER_OVERLAYS.map((overlay) => {
      const state = states[String(RENDER_OVERLAY_OPTION_IDS[overlay])];
      if (state === undefined) {
        throw new ActionableError(
          `CoreSimulator returned no state for render overlay ${overlay} (option ` +
            `${RENDER_OVERLAY_OPTION_IDS[overlay]})`,
        );
      }
      return [overlay, state];
    }),
  ) as Record<RenderOverlay, boolean>;
}
