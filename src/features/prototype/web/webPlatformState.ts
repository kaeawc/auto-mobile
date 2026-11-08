import type { Posture } from "../../../models/DisplayPanel";
import { dataPlaceholderSpans } from "../prototypeData";
import { PROTOTYPE_WIDTH_CLASS_BREAKPOINTS } from "../prototypeRenderContract.generated";

/** The fold a still draws: its posture and which way the hinge runs across the active panel. */
export interface StillFold {
  readonly posture: Posture;
  readonly hinge: "horizontal" | "vertical";
}

export interface StillPlatformInput {
  readonly platform: "android" | "ios";
  /** The active panel's width and height in the drawn orientation, in dp. */
  readonly widthDp: number;
  readonly heightDp: number;
  /** Absent on a frame without a hinge. */
  readonly fold?: StillFold;
}

/**
 * Platform state a still decides, keyed by `/platform` pointer. A listed key with an undefined
 * value is one the device never reports in this frame (posture on iOS or without a fold), so it
 * compares as missing; a pointer that is not listed stays undecidable.
 */
export type StillPlatformState = Readonly<Record<string, unknown>>;

const WIDTH_BREAKPOINTS: readonly number[] = PROTOTYPE_WIDTH_CLASS_BREAKPOINTS;

/** iPads are regular full screen; an iPhone is regular only in landscape on the widest models. */
const IOS_TABLET_SMALLEST_DP = 600;
const IOS_REGULAR_PHONE_WIDTH_DP = 896;

function androidWidthClass(width: number): string {
  const [medium = 600, expanded = 840] = WIDTH_BREAKPOINTS;
  if (width < medium) {
    return "compact";
  }
  return width < expanded ? "medium" : "expanded";
}

function iosWidthClass(width: number, height: number): string {
  const tablet = Math.min(width, height) >= IOS_TABLET_SMALLEST_DP;
  return tablet || width >= IOS_REGULAR_PHONE_WIDTH_DP ? "regular" : "compact";
}

/** Android's `/device/posture`: flat when opened; half-opened is tabletop or book by hinge. */
function androidPosture(fold: StillFold | undefined): string | undefined {
  if (fold?.posture === "opened") {
    return "flat";
  }
  if (fold?.posture === "half_opened") {
    return fold.hinge === "horizontal" ? "tabletop" : "book";
  }
  return undefined;
}

export function stillPlatformState(input: StillPlatformInput): StillPlatformState {
  const width = Math.round(input.widthDp);
  const height = Math.round(input.heightDp);
  return {
    "/device/os": input.platform,
    "/device/widthClass":
      input.platform === "android" ? androidWidthClass(width) : iosWidthClass(width, height),
    "/device/posture": input.platform === "android" ? androidPosture(input.fold) : undefined,
  };
}

/**
 * Binds `{platform:/pointer}` placeholders the frame decides, as the devices do in their data pass:
 * a string value goes through `insert`, a value the device never reports is empty, and an undecided
 * placeholder stays literal. `key` maps a scanned pointer back to its authored form.
 */
export function bindStillPlatformText(
  text: string,
  state: StillPlatformState | undefined,
  key: (pointer: string) => string,
  insert: (value: string) => string,
): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const span of dataPlaceholderSpans(text, "platform:")) {
    const pointer = key(span.pointer);
    if (state && Object.hasOwn(state, pointer)) {
      const value = state[pointer];
      parts.push(text.slice(cursor, span.start), typeof value === "string" ? insert(value) : "");
      cursor = span.end;
    }
  }
  return cursor === 0 ? text : parts.join("") + text.slice(cursor);
}
