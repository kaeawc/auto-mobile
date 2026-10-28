import { record, type Raw } from "./prototypeTemplate";
import type { PrototypePlatformError } from "./prototypePlatform";

const webUrl = /^https?:/;

/** Custom Tabs and SFSafariViewController load only web pages, so `inApp` needs an http(s) URL.
 * Bound arguments are checked by the runtime once they resolve.
 */
export function prototypeLinksArgumentsError(
  args: Raw,
  path: string,
): PrototypePlatformError | undefined {
  const url = record(args.url)?.value;
  if (record(args.mode)?.value !== "inApp" || typeof url !== "string" || webUrl.test(url)) {
    return undefined;
  }
  return {
    path: `${path}.mode.value`,
    message: "links.open mode inApp requires an http or https url",
  };
}
