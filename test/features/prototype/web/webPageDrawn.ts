import { deviceFrameOrThrow } from "../../../../src/features/prototype/web/deviceFrames";
import { defaultFramePosture, framePostures } from "../../../../src/features/prototype/web/webFold";
import { frameOrientations } from "../../../../src/features/prototype/web/webFrame";
import {
  prototypeWebPageViewDrawer,
  type PrototypeWebPageData,
} from "../../../../src/features/prototype/web/webPageData";

/** The page's inlined data block, parsed as the page bundle reads it. */
export function webPageData(html: string): PrototypeWebPageData {
  // The markup PROTOTYPE_WEB_PAGE_DATA_SELECTOR finds.
  const open = '<script type="application/json" data-prototype-page="">';
  const start = html.indexOf(open);
  if (start < 0) {
    throw new Error("The page has no data block");
  }
  const body = html.slice(start + open.length, html.indexOf("</script>", start));
  return JSON.parse(body) as PrototypeWebPageData;
}

/** The view the host drew into the page: the one shown first, without `hidden`. */
export function webPageShownView(html: string): string {
  const start = html.indexOf('<div data-stage="">') + '<div data-stage="">'.length;
  // The view is one `div`: scan to the close that matches its open.
  const tags = /<div[\s>]|<\/div>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[0] === "</div>" ? -1 : 1;
    if (depth === 0) {
      return html.slice(start, match.index + match[0].length);
    }
  }
  throw new Error("The page has no shown view");
}

/**
 * Every view the page shows once the viewer has visited each revision, orientation and posture
 * (#16528): the host's first view, then what the page bundle's drawer draws from the data, in the
 * order the host used to pre-render them (each revision's screen groups, start first, each over
 * the default posture's orientations, then the other postures').
 */
export function webPageDrawnViews(html: string): string {
  const data = webPageData(html);
  const shown = webPageShownView(html);
  const hiddenShown = shown.replace('data-view="">', 'data-view="" hidden="">');
  const frame = deviceFrameOrThrow(data.frame);
  const posture = defaultFramePosture(frame);
  const postures =
    posture === undefined
      ? [""]
      : [posture, ...framePostures(frame).filter((entry) => entry !== posture)];
  const points = postures.flatMap((entry) =>
    frameOrientations(frame).map((orientation) => ({ orientation, posture: entry })),
  );
  const drawn: string[] = [];
  const draw = prototypeWebPageViewDrawer(data, {
    views: () => [],
    insert: (view) => drawn.push(view),
  });
  return data.revisions
    .flatMap((revision) => {
      const perPoint = points.map((point) => {
        drawn.length = 0;
        draw({ variant: revision.variant, revision: String(revision.revision), ...point });
        return [...drawn];
      });
      const count = Math.max(...perPoint.map((views) => views.length));
      return Array.from({ length: count }, (_, index) =>
        perPoint.flatMap((views) => views.slice(index, index + 1)),
      ).flat();
    })
    .map((view) => (view === hiddenShown ? shown : view))
    .join("");
}
