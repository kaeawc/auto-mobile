import { prototypeLinkifyMatches, type PrototypeLinkifyKind } from "../prototypeLinkify";
import { record, type Raw } from "../prototypeTemplate";
import { el, type WebChild } from "./webNodes";
import { cssColor, textCss, type WebStyleContext } from "./webStyle";

/** A span with its own text style and background; a link is marked, since a still never taps. */
function styledSpan(text: string, style: Raw | undefined, link: boolean, context: WebStyleContext) {
  const background = cssColor(style?.background, context);
  const css = {
    ...textCss(style, context),
    ...(background ? { "background-color": background } : {}),
  };
  return el("span", { attrs: link ? { "data-link": "true" } : {}, style: css }, [text]);
}

/**
 * `linkify`: the resolved text split into plain runs and one link per match, in its `style`, as
 * Android draws it; plain text when nothing matches.
 */
function linkified(text: string, linkify: Raw, context: WebStyleContext): WebChild[] {
  const kinds = Array.isArray(linkify.kinds) ? (linkify.kinds as PrototypeLinkifyKind[]) : [];
  const matches = prototypeLinkifyMatches(text, kinds);
  if (matches.length === 0) {
    return [text];
  }
  const runs: WebChild[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      runs.push(text.slice(cursor, match.start));
    }
    runs.push(styledSpan(match.text, record(linkify.style), true, context));
    cursor = match.end;
  }
  return cursor < text.length ? [...runs, text.slice(cursor)] : runs;
}

/** A text node's content: its `text` (linkified when asked), or each span in its own style. */
export function textRuns(
  node: Raw,
  bind: (text: unknown) => string,
  context: WebStyleContext,
): WebChild[] {
  if (!Array.isArray(node.spans)) {
    const linkify = record(node.linkify);
    const text = bind(node.text);
    return linkify ? linkified(text, linkify, context) : [text];
  }
  return node.spans.map((span) => {
    const entry = record(span) ?? {};
    const link = Array.isArray(entry.onTap) && entry.onTap.length > 0;
    return styledSpan(bind(entry.text), record(entry.style), link, context);
  });
}
