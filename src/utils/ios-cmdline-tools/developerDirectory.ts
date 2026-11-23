import path from "node:path";

/** Where xcode-select keeps the selected Xcode's developer directory. */
export const XCODE_SELECT_LINK = "/var/db/xcode_select_link";

/**
 * The developer directory a DEVELOPER_DIR value names: the supported `Xcode.app` shorthand
 * resolves to `Xcode.app/Contents/Developer`, anything else is already the directory.
 */
export function developerDirectoryOf(selected: string): string {
  const trimmed = selected.replace(/\/+$/, "");
  return trimmed.endsWith(".app") ? path.join(trimmed, "Contents/Developer") : trimmed;
}
