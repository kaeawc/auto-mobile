import { record } from "./prototypeTemplate";
import { prototypePlatformUses, type PrototypePlatformError } from "./prototypePlatform";

/** `settings.open` pages iOS can open; the contract's other pages are Android only (#16520). */
export const PROTOTYPE_SETTINGS_IOS_PAGES: ReadonlySet<string> = new Set(["app", "notifications"]);

/**
 * The first `settings.open` call whose literal `page` the target platform cannot open, at the
 * action's path. A bound page is only known on the device, so the runtime reports it.
 */
export function prototypeSettingsPagePlatformError(
  spec: unknown,
  platform: "android" | "ios",
): PrototypePlatformError | undefined {
  if (platform === "android") {
    return undefined;
  }
  for (const use of prototypePlatformUses(spec)) {
    if (use.kind !== "call" || use.action.call !== "settings.open") {
      continue;
    }
    const page = record(record(use.action.args)?.page)?.value;
    if (typeof page === "string" && !PROTOTYPE_SETTINGS_IOS_PAGES.has(page)) {
      return {
        path: use.path,
        message: `settings.open page "${page}" is Android only; on iOS use "app" or "notifications"`,
      };
    }
  }
  return undefined;
}
