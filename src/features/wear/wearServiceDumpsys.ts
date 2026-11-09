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

/** One complication slot of a watch-face favorite. */
export interface ComplicationSlot {
  slot: number;
  /** Complication data type id (`mDataType` / `type`). */
  type: number;
  /** Data source as `<package>/<class>`, or null when the slot is empty. */
  provider: string | null;
}

export interface WatchFaceFavorite {
  favoriteId: number;
  package: string;
  slots: ComplicationSlot[];
}

export interface ActiveWatchFace {
  package: string;
  favoriteId: number | null;
  /** `isFallbackWatchFace=true`: the classic fallback face, which has no complication slots. */
  fallback: boolean;
}

export interface WatchFaceObservation {
  activeFace: ActiveWatchFace;
  favorites: WatchFaceFavorite[];
  /** `inAmbient` from the watch face's state; undefined when that line is absent. */
  ambient?: boolean;
}

const SECTION_HEADER = /^Wear Service API: (\S+)\s*$/;
const ACTIVE_COMPONENT = /^activeWatchFaceComponent=WatchFaceId\[([^,\]]+),[^\]]*\]\s*$/m;
const ACTIVE_FAVORITE_ID = /^favoriteId=(\d+)\s*$/m;
const FALLBACK = /^isFallbackWatchFace=(true|false)\s*$/m;
const FAVORITES_HEADER = /^(\s*)All Favorites in Database:\s*$/;
const FAVORITE_ROW = /^\s+id=(\d+) packageName=(\S+)/;
const PROVIDER = String.raw`(null|ComponentInfo\{([^}]*)\})`;
const COMPLICATION_INFO = new RegExp(
  String.raw`ComplicationInfo\{mWatchFaceSlotId=(\d+), mProviderComponent=${PROVIDER}, mDataType=(-?\d+)`,
);
const LIVE_FAVORITE_ID = /activeWatchFaceFavoriteId=WatchFaceFavoriteId\{.*?mFavoriteId=(\d+)/;
const LIVE_CONFIG = new RegExp(
  String.raw`^\s*id=\d+ slot=(\d+) type=(-?\d+) .*?provider=${PROVIDER}`,
);

/** Section bodies keyed by the name in each `Wear Service API: <name>` header. */
export function splitWearServiceSections(dumpsys: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of dumpsys.replace(/\r\n/g, "\n").split("\n")) {
    const header = SECTION_HEADER.exec(line);
    if (header) {
      current = [];
      sections.set(header[1], current);
    } else {
      current?.push(line);
    }
  }
  return sections;
}

function slot(slotId: string, type: string, provider: string | undefined): ComplicationSlot {
  return { slot: Number(slotId), type: Number(type), provider: provider ?? null };
}

/** Favorites under `All Favorites in Database:`, each with its stored `ComplicationInfo` slots. */
function parseFavorites(lines: string[]): WatchFaceFavorite[] {
  const start = lines.findIndex((line) => FAVORITES_HEADER.test(line));
  if (start < 0) {
    return [];
  }
  const indent = FAVORITES_HEADER.exec(lines[start])?.[1].length ?? 0;
  const favorites: WatchFaceFavorite[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length <= indent) {
      break;
    }
    const row = FAVORITE_ROW.exec(line);
    if (row) {
      favorites.push({ favoriteId: Number(row[1]), package: row[2], slots: [] });
      continue;
    }
    const info = COMPLICATION_INFO.exec(line);
    if (info) {
      favorites.at(-1)?.slots.push(slot(info[1], info[4], info[3]));
    }
  }
  return favorites;
}

/** The `ComplicationsConfigController` configs: the live slots of the active favorite. */
function parseLiveSlots(
  lines: string[] | undefined,
): { favoriteId: number; slots: ComplicationSlot[] } | null {
  const start = lines?.findIndex((line) => line.trim() === "ComplicationsConfigController") ?? -1;
  if (!lines || start < 0) {
    return null;
  }
  const body = lines.slice(start + 1);
  const favoriteId = body.map((line) => LIVE_FAVORITE_ID.exec(line)?.[1]).find(Boolean);
  if (favoriteId === undefined) {
    return null;
  }
  const slots = body.flatMap((line) => {
    const config = LIVE_CONFIG.exec(line);
    return config ? [slot(config[1], config[2], config[4])] : [];
  });
  return { favoriteId: Number(favoriteId), slots };
}

/**
 * Watch faces and complications from `dumpsys wear_service`. `null` when the `watch_faces`
 * section or its `activeWatchFaceComponent` line is missing. The active favorite's slots come
 * from `ComplicationsConfigController` (the live state) when it names that favorite; the others
 * keep their stored `ComplicationInfo` slots.
 */
export function parseWatchFaces(dumpsys: string): WatchFaceObservation | null {
  const sections = splitWearServiceSections(dumpsys);
  const watchFaces = sections.get("watch_faces");
  const activeFace = watchFaces ? parseActiveFace(watchFaces.join("\n")) : null;
  if (!watchFaces || !activeFace) {
    return null;
  }
  const complications = sections.get("complications");
  const live = activeFace.fallback ? null : parseLiveSlots(complications);
  const favorites = parseFavorites(watchFaces).map((favorite) =>
    live && favorite.favoriteId === live.favoriteId ? { ...favorite, slots: live.slots } : favorite,
  );
  const ambient = parseWatchFaceState(complications?.join("\n") ?? "")?.inAmbient;
  return { activeFace, favorites, ...(ambient === undefined ? {} : { ambient }) };
}

/** `activeWatchFaceComponent=WatchFaceId[<pkg>,null]`, `favoriteId=<n>` and the fallback flag. */
function parseActiveFace(watchFaces: string): ActiveWatchFace | null {
  const activePackage = ACTIVE_COMPONENT.exec(watchFaces)?.[1];
  if (activePackage === undefined) {
    return null;
  }
  const favoriteId = ACTIVE_FAVORITE_ID.exec(watchFaces)?.[1];
  return {
    package: activePackage,
    favoriteId: favoriteId === undefined ? null : Number(favoriteId),
    fallback: FALLBACK.exec(watchFaces)?.[1] === "true",
  };
}
