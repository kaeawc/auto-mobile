import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";

/**
 * `dumpsys wear_service` readings shared by Wear features (ambient readback #17519, watch-face
 * observation #17518). Keep this to parsing and one read; callers decide what a reading means.
 */

/** The watch face's own view of itself, from `watchFaceState=WatchFaceState{...}`. */
export interface WatchFaceState {
  watchFaceVisible: boolean;
  inAmbient: boolean;
}

export type WearServiceAdb = Pick<AdbExecutor, "execute">;

const READ_TIMEOUT_MS = 10_000;
const WATCH_FACE_STATE = /watchFaceState=WatchFaceState\{([^}]*)\}/;

/** One `dumpsys wear_service` read; returns stdout as-is for the parsers below. */
export async function readWearServiceDumpsys(
  adb: WearServiceAdb,
  signal?: AbortSignal,
): Promise<string> {
  const result = await adb.execute(["shell", "dumpsys", "wear_service"], {
    noRetry: true,
    timeoutMs: READ_TIMEOUT_MS,
    signal,
  });
  return result.stdout;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}

/** `null` when the line is absent or either field is missing or not a boolean. */
export function parseWatchFaceState(dumpsys: string): WatchFaceState | null {
  const body = WATCH_FACE_STATE.exec(dumpsys)?.[1];
  if (body === undefined) {
    return null;
  }
  const fields = new Map(
    body.split(",").map((pair) => {
      const [key = "", value = ""] = pair.split("=");
      return [key.trim(), value.trim()] as const;
    }),
  );
  const watchFaceVisible = parseBoolean(fields.get("watchFaceVisible"));
  const inAmbient = parseBoolean(fields.get("inAmbient"));
  if (watchFaceVisible === undefined || inAmbient === undefined) {
    return null;
  }
  return { watchFaceVisible, inAmbient };
}

/** A `WatchFaceId[<package>,<class|null>]`; resource-only (WFF) faces have a null class. */
export interface WatchFaceIdReading {
  package: string;
  className: string | null;
}

/** One `ComplicationsConfigController` active-config line: the live state of the active face. */
export interface ComplicationSlotReading {
  slot: number;
  type: number;
  /** `<package>/<class>` of the provider, or null for an empty slot. */
  provider: string | null;
}

export interface WatchFaceReading {
  activeFace?: WatchFaceIdReading;
  /** The active face's favorite id (`favoriteId=<n>` in the watch_faces section). */
  favoriteId?: number;
  slots: ComplicationSlotReading[];
}

const ACTIVE_FACE = /activeWatchFaceComponent=WatchFaceId\[([^,\]]+),([^\]]*)\]/;
const FAVORITE_ID = /(?:^|\s)favoriteId=(\d+)/m;
const ACTIVE_CONFIG =
  /^\s*id=\d+ slot=(\d+) type=(\d+) configActionPending=\S+ provider=(?:null|ComponentInfo\{([^}]*)\})/gm;

/** Reads the active face and its live complication slots; absent lines leave fields unset. */
export function parseWatchFaceReading(dumpsys: string): WatchFaceReading {
  const text = dumpsys.replace(/\r\n/g, "\n");
  const face = ACTIVE_FACE.exec(text);
  const favorite = FAVORITE_ID.exec(text);
  const slots = [...text.matchAll(ACTIVE_CONFIG)].map((match) => ({
    slot: Number(match[1]),
    type: Number(match[2]),
    provider: match[3] ?? null,
  }));
  return {
    ...(face
      ? { activeFace: { package: face[1], className: face[2] === "null" ? null : face[2] } }
      : {}),
    ...(favorite ? { favoriteId: Number(favorite[1]) } : {}),
    slots,
  };
}
