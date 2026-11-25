import { ActionableError } from "../../models/ActionableError";
import { commandFailureDetails } from "../../utils/CommandError";
import { errorMessage } from "../../utils/describeUnknownError";

/**
 * `openLink` reached a device that resolves the URL only to a target adb cannot start (#19180).
 * Wear OS has no browser: it resolves web URLs to the "open on phone" redirect activity, which
 * needs a permission the shell lacks. Typed so callers can tell this from an unresolved intent.
 */
export class OpenUrlUnsupportedError extends ActionableError {}

/** Markers of the Wear OS "open on phone" redirect that `am start` cannot start. */
const WEAR_URI_REDIRECT_MARKERS = ["UriRedirectActivity", "URI_REDIRECT_TO_REMOTE"];

/** The first `...Exception: ...` line of `am start` output, which names the cause. */
function exceptionLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\b[\w.$]*Exception: /.test(line));
}

/**
 * The refusal for a Wear OS URI redirect in `am start` output, keeping the device's exception
 * line; undefined when the output is not that redirect.
 */
export function wearUriRedirectError(
  url: string,
  output: string,
): OpenUrlUnsupportedError | undefined {
  if (!WEAR_URI_REDIRECT_MARKERS.some((marker) => output.includes(marker))) {
    return undefined;
  }
  const cause = exceptionLine(output);
  return new OpenUrlUnsupportedError(
    `openLink cannot open ${url}: Wear OS has no browser, so the link resolves only to the ` +
      "paired phone's redirect (UriRedirectActivity), which adb cannot start. Use an app deep " +
      "link the watch app handles, or launchApp." +
      (cause ? ` Device reported: ${cause}` : ""),
  );
}

/** The text of a rejected `am start`: its message plus every stream along the cause chain. */
export function amStartFailureText(error: unknown): string {
  const { stdout, stderr } = commandFailureDetails(error);
  return [errorMessage(error), stdout, stderr].join("\n");
}
