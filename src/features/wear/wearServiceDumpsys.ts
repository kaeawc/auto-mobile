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
