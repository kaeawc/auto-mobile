import { DefaultElementParser } from "./ElementParser";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { DefaultElementGeometry } from "./ElementGeometry";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";

/** Optional element parsing/geometry overrides, so tests can inject deterministic ones. */
export interface DeepLinkElementServices {
  parser?: ElementParser;
  geometry?: ElementGeometry;
}

export const resolveElementServices = (
  services: DeepLinkElementServices,
): Required<DeepLinkElementServices> => ({
  parser: services.parser ?? new DefaultElementParser(),
  geometry: services.geometry ?? new DefaultElementGeometry(),
});
