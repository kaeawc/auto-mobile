import { ResourceRegistry } from "./resourceRegistry";
import {
  ICON_LOOKUP_LIMIT,
  PROTOTYPE_GUIDE_URI,
  PROTOTYPE_ICONS_TEMPLATE,
  PROTOTYPE_ICONS_URI,
  renderPrototypeGuide,
  searchIcons,
} from "../features/prototype/prototypeGuide";
import { encodeUriSegment } from "../utils/encodeUriSegment";

/** Registers the `prototype` authoring guide and its icon lookup (#11052). */
export function registerPrototypeResources(): void {
  ResourceRegistry.register(
    PROTOTYPE_GUIDE_URI,
    "Prototype authoring guide",
    "Node and action vocabulary, repeat grammar, limits, theme roles and icon lookup for the prototype tool",
    "text/markdown",
    async () => ({
      uri: PROTOTYPE_GUIDE_URI,
      mimeType: "text/markdown",
      text: renderPrototypeGuide(),
    }),
  );

  ResourceRegistry.registerTemplate(
    PROTOTYPE_ICONS_TEMPLATE,
    "Prototype icon lookup",
    `Material icon names containing the query (at most ${ICON_LOOKUP_LIMIT} per read)`,
    "application/json",
    async (params: Record<string, string>) => {
      const query = params.query ?? "";
      const { total, names } = searchIcons(query);
      return {
        uri: `${PROTOTYPE_ICONS_URI}?query=${encodeUriSegment(query)}`,
        mimeType: "application/json",
        text: JSON.stringify({ query, total, truncated: total > names.length, names }),
      };
    },
  );
}
