import { ActionableError } from "../../models/ActionableError";
import { commandFailureDetails } from "../../utils/CommandError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { rethrowDeviceTransportUnavailable } from "../../utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import {
  defaultAndroidTvDetector,
  type AndroidTvDetector,
} from "../../utils/android-cmdline-tools/androidTvDevice";
import {
  defaultXrGlassesDetector,
  type XrGlassesDetector,
} from "../../utils/android-cmdline-tools/xrGlassesDevice";

/**
 * `openLink` reached a device with no real handler for the URL. Wear OS has no browser: it resolves
 * web URLs to the "open on phone" redirect activity, which needs a permission the shell lacks
 * (#19180). An Android TV may resolve them only to a framework stub, and Android XR glasses to
 * nothing (#19233). Typed so callers can tell this from an unresolved intent on a phone.
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

/** The form-factor predicates `openLink` asks before it starts a VIEW intent (tests pass fakes). */
export interface OpenUrlFormFactorOptions {
  tvDetector?: AndroidTvDetector;
  glassesDetector?: XrGlassesDetector;
}

/**
 * Package of the Android TV framework stubs (`Stubs$BrowserStub` and friends). A TV image without
 * a browser resolves web URLs to it, so `am start` succeeds while nothing opens (#19233).
 */
export const TV_FRAMEWORK_STUBS_PACKAGE = "com.android.tv.frameworkpackagestubs";

/** The Android `openLink` call the handler check is asked about. */
export interface OpenUrlRequest {
  device: BootedDevice;
  adb: AdbExecutor;
  url: string;
  signal?: AbortSignal;
}

/** The resolved activity of `cmd package resolve-activity --brief`, or null when none resolves. */
export function parseResolvedViewActivity(stdout: string): string | null {
  const lastLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  return lastLine && /^[^\s/]+\/\S+$/.test(lastLine) ? lastLine : null;
}

/** True when `component` is a framework stub that shows nothing for the intent. */
function isStubActivity(component: string): boolean {
  return component.startsWith(`${TV_FRAMEWORK_STUBS_PACKAGE}/`) || /\$\w*Stub$/.test(component);
}

/** Reads the activity a VIEW intent for `url` resolves to; null when nothing resolves. */
async function resolveViewActivity(
  adb: AdbExecutor,
  url: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await adb.execute(
    [
      "shell",
      `cmd package resolve-activity --brief -a android.intent.action.VIEW -d ${shellQuote(url)}`,
    ],
    { signal },
  );
  return parseResolvedViewActivity(result.stdout);
}

/** Which no-browser form factor the device is, asked one predicate at a time; undefined for others. */
async function noBrowserFormFactor(
  device: BootedDevice,
  adb: AdbExecutor,
  {
    tvDetector = defaultAndroidTvDetector,
    glassesDetector = defaultXrGlassesDetector,
  }: OpenUrlFormFactorOptions,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const evidence = { device, adb, signal };
  if (await tvDetector.isAndroidTv(evidence)) {
    return "Android TV";
  }
  signal?.throwIfAborted();
  if (await glassesDetector.isXrGlasses(evidence)) {
    return "Android XR glasses";
  }
  signal?.throwIfAborted();
  return undefined;
}

/**
 * Throw {@link OpenUrlUnsupportedError} before any `am start` when an Android TV or Android XR
 * glasses device resolves the URL to nothing or only to a framework stub (#19233): `am start` would
 * report success on the TV BrowserStub while nothing opens, and fail with a raw command dump on
 * glasses. Other form factors are not probed for a resolver. An unreadable resolver falls through to
 * `am start`, whose own result then decides.
 */
export async function refuseOpenUrlWithoutHandler(
  { device, adb, url, signal }: OpenUrlRequest,
  formFactors: OpenUrlFormFactorOptions = {},
): Promise<void> {
  const formFactor = await noBrowserFormFactor(device, adb, formFactors, signal);
  if (!formFactor) {
    return;
  }
  let activity: string | null;
  try {
    activity = await resolveViewActivity(adb, url, signal);
  } catch (error) {
    signal?.throwIfAborted();
    rethrowDeviceTransportUnavailable(error);
    // The resolver read is advisory: am start runs next and reports its own failure.
    logger.warn(
      `[OpenURL] resolve-activity for ${url} on ${device.deviceId} failed: ${errorMessage(error)}`,
      error,
    );
    return;
  }
  signal?.throwIfAborted();
  if (activity !== null && !isStubActivity(activity)) {
    return;
  }
  const resolved =
    activity === null
      ? "no installed app handles it"
      : `it resolves only to the framework stub ${activity}, which shows nothing`;
  throw new OpenUrlUnsupportedError(
    `openLink cannot open ${url} on ${formFactor} ${device.deviceId}: ${resolved}, so no intent ` +
      "was started. Use an app deep link an installed app handles, or launchApp.",
  );
}
