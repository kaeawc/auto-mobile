import { ALIGN_SELF, COLUMN, FLEX, FLEX_DIRECTION, MIN_HEIGHT, STRETCH } from "./webCss";
import { record, type Raw } from "../prototypeTemplate";
import { el } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";

/** The outermost stack a still drew: its screens in key order and the one it drew. */
export interface WebStackScreens {
  readonly start: string;
  readonly screens: readonly string[];
  readonly screen: string;
}

/**
 * The screen a stack draws without recording it: the outermost stack draws the still's chosen
 * screen when the stack has it, any other its own start (else its first screen).
 */
export function stackScreen(
  node: Raw,
  scope: WebRenderScope,
  outermost: boolean,
): string | undefined {
  const screens = record(node.screens) ?? {};
  const start = typeof node.start === "string" ? node.start : Object.keys(screens)[0];
  const chosen = scope.screen;
  return outermost && start !== undefined && chosen !== undefined && Object.hasOwn(screens, chosen)
    ? chosen
    : start;
}

/**
 * The screen a stack draws. The first stack drawn is the outermost one; it draws the still's
 * chosen screen when it has one and records itself. Every other stack draws its own start.
 */
function shownScreen(node: Raw, scope: WebRenderScope): string | undefined {
  const stacks = scope.stacks;
  const outermost = stacks !== undefined && stacks.length === 0;
  const screen = stackScreen(node, scope, outermost);
  if (!outermost || screen === undefined) {
    return screen;
  }
  const start = stackScreen(node, scope, false)!;
  stacks.push({ start, screens: Object.keys(record(node.screens) ?? {}), screen });
  return screen;
}

export function webStackRenderers(kit: WebRenderKit): Readonly<Record<string, NodeRenderer>> {
  const stack: NodeRenderer = (node, scope, path) => {
    const screens = record(node.screens) ?? {};
    const shown = shownScreen(node, scope);
    const { attrs, style } = kit.base(node, scope, { display: FLEX, [FLEX_DIRECTION]: COLUMN });
    const inner = kit.child(scope, {
      inBox: false,
      style: { ...scope.style, parentAxis: COLUMN },
    });
    const screen = shown === undefined ? undefined : screens[shown];
    const content = kit.renderNode(screen, inner, `${path}.screens[${JSON.stringify(shown)}]`);
    // A stack screen fills the stack, as on both devices.
    const filled = content
      ? [
          {
            ...content,
            style: {
              ...content.style,
              flex: "1 1 auto",
              [MIN_HEIGHT]: "0",
              [ALIGN_SELF]: STRETCH,
            },
          },
        ]
      : [];
    return el("div", { attrs, style }, filled);
  };
  return { stack };
}
