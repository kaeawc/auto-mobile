import { defaultDeviceFrameId, deviceFrameOrThrow } from "../deviceFrames";
import { PrototypeWebInputError } from "../prototypeWebInputError";
import { frameOrientations, type WebOrientation } from "../webFrame";
import type { WebElement } from "../webNodes";
import type { UnsupportedWebNode } from "../webRender";
import { renderPrototypeStill } from "../webStill";
import type { StillTextSize } from "../webTextScale";
import { envelopeGlyphSource, type PrototypeGlyphParser } from "./prototypeWebGlyphs";
import { PrototypeWebRefusal, readPrototypeWebInput } from "./prototypeWebInput";

/** Options of the pure `renderPrototype`; `mount` resolves `system` mode and `fit` zoom first. */
export interface PrototypeRenderOptions {
  /** A device frame id, or `false` for the default frame's screen alone (chromeless). */
  readonly frame?: string | false;
  readonly orientation?: WebOrientation;
  readonly mode?: "light" | "dark";
  /** A screen key of the outermost stack; an unknown key draws the stack's start. */
  readonly screen?: string;
  /** BCP 47 tag for string tables, formatting and layout direction (default `en-US`). */
  readonly locale?: string;
  readonly textSize?: StillTextSize;
  /** Parses envelope glyph markup; `mount` passes the browser's. Without one icons draw a placeholder. */
  readonly parseGlyph?: PrototypeGlyphParser;
}

/** The outermost stack drawn: the screen picker's choices, its start first. */
export interface PrototypeRenderedStack {
  readonly start: string;
  readonly screens: readonly string[];
  readonly screen: string;
}

export interface PrototypeRendered {
  readonly element: WebElement;
  /** The frame drawn, or `false` when chromeless. */
  readonly frame: string | false;
  readonly orientation: WebOrientation;
  /** The orientations the frame has, its first the default. */
  readonly orientations: readonly WebOrientation[];
  readonly unsupportedNodes: readonly UnsupportedWebNode[];
  readonly stack?: PrototypeRenderedStack;
}

const DEFAULT_FRAME = defaultDeviceFrameId("android");

/** Runs `draw`, turning the renderer's input errors into an `invalidOption` refusal. */
function refusingInputErrors<T>(draw: () => T): T {
  try {
    return draw();
  } catch (error) {
    if (error instanceof PrototypeWebInputError) {
      throw new PrototypeWebRefusal("invalidOption", error.message);
    }
    throw error;
  }
}

/** The stack's screens with its start first, as the picker offers them. */
function pickerStack(
  stack: PrototypeRenderedStack | undefined,
): PrototypeRenderedStack | undefined {
  if (!stack) {
    return undefined;
  }
  const rest = stack.screens.filter((screen) => screen !== stack.start);
  const screens = stack.screens.includes(stack.start) ? [stack.start, ...rest] : [...stack.screens];
  return { start: stack.start, screens, screen: stack.screen };
}

/**
 * Draws a prototype spec or embed envelope as a still element tree, with no DOM: the same tree the
 * prototype web page draws. Throws `PrototypeWebRefusal` for an envelope it cannot draw whole or
 * an option the renderer refuses.
 */
export function renderPrototype(
  spec: unknown,
  options: PrototypeRenderOptions = {},
): PrototypeRendered {
  const input = readPrototypeWebInput(spec);
  const frameId = options.frame === false ? DEFAULT_FRAME : (options.frame ?? DEFAULT_FRAME);
  const orientations = refusingInputErrors(() => frameOrientations(deviceFrameOrThrow(frameId)));
  const orientation = options.orientation ?? orientations[0] ?? "portrait";
  const glyphs =
    input.glyphs && options.parseGlyph
      ? envelopeGlyphSource(input.glyphs, options.parseGlyph)
      : undefined;
  const still = refusingInputErrors(() =>
    renderPrototypeStill(input.spec, {
      frame: frameId,
      orientation,
      ...(options.frame === false ? { chromeless: true } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.screen === undefined ? {} : { screen: options.screen }),
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.textSize === undefined ? {} : { textSize: options.textSize }),
      ...(glyphs ? { glyphs } : {}),
    }),
  );
  const stack = pickerStack(still.stack);
  return {
    element: still.element,
    frame: options.frame === false ? false : still.frame,
    orientation,
    orientations,
    unsupportedNodes: still.unsupportedNodes,
    ...(stack ? { stack } : {}),
  };
}
