import { toActionableError } from "../../models/ActionableError";
import {
  parseWatchFaces,
  readWearServiceDumpsys,
  type ActiveWatchFace,
  type WatchFaceFavorite,
  type WearServiceAdb,
} from "./wearServiceDumpsys";

/** Read-only watch-face observation from `dumpsys wear_service` (#17518). */
export interface WatchFaceResult {
  /** True when the watch faces could be read; false is the typed "unavailable" result. */
  success: boolean;
  action: "watchFace";
  available: boolean;
  activeFace?: ActiveWatchFace;
  favorites?: WatchFaceFavorite[];
  /** `inAmbient` from the watch face's state; absent when not reported. */
  ambient?: boolean;
  message: string;
  reason?: string;
}

export interface WatchFaceReader {
  observe(signal?: AbortSignal): Promise<WatchFaceResult>;
}

const UNAVAILABLE_REASON =
  "dumpsys wear_service printed no watch_faces section with an activeWatchFaceComponent line; this build may not run Wear OS services or may format them differently.";

export class AdbWatchFaceReader implements WatchFaceReader {
  constructor(private readonly adb: WearServiceAdb) {}

  async observe(signal?: AbortSignal): Promise<WatchFaceResult> {
    let dumpsys: string;
    try {
      signal?.throwIfAborted();
      dumpsys = await readWearServiceDumpsys(this.adb, signal);
    } catch (error) {
      throw toActionableError(error, "Failed to read adb shell dumpsys wear_service");
    }
    const observation = parseWatchFaces(dumpsys);
    if (!observation) {
      return {
        success: false,
        action: "watchFace",
        available: false,
        message: "The watch faces could not be read.",
        reason: UNAVAILABLE_REASON,
      };
    }
    const { activeFace } = observation;
    return {
      success: true,
      action: "watchFace",
      available: true,
      ...observation,
      message: `Active watch face ${activeFace.package}${activeFace.favoriteId === null ? "" : ` (favorite ${activeFace.favoriteId})`}${activeFace.fallback ? ", the fallback face" : ""}; ${observation.favorites.length} favorite(s).`,
    };
  }
}
