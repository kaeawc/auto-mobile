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
 * The screen a stack draws. The first stack drawn is the outermost one; it draws the still's
 * chosen screen when it has one and records itself. Every other stack draws its own start.
 */
function shownScreen(node: Raw, scope: WebRenderScope): string | undefined {
  const screens = record(node.screens) ?? {};
  const ids = Object.keys(screens);
  const start = typeof node.start === "string" ? node.start : ids[0];
  const stacks = scope.stacks;
  if (!stacks || stacks.length > 0 || start === undefined) {
    return start;
  }
  const chosen = scope.screen;
  const screen = chosen !== undefined && Object.hasOwn(screens, chosen) ? chosen : start;
  stacks.push({ start, screens: ids, screen });
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
