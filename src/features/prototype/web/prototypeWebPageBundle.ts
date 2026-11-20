import { version } from "../../../../package.json";
import {
  PROTOTYPE_WEB_PAGE_BUNDLE_SOURCE,
  PROTOTYPE_WEB_PAGE_BUNDLE_VERSION_MARK,
} from "./prototypeWebPageBundle.generated";

/**
 * The prototype web page's script (#16528): the committed build of
 * `packages/prototype-web/src/page.ts`, the same renderer and `mount` as the library, with this
 * release's version in place of the build's version mark. Read from the committed file, never
 * built at request time, so the same release always inlines the same bytes.
 */
export function prototypeWebPageBundle(
  packageVersion: string = version,
  source: string = PROTOTYPE_WEB_PAGE_BUNDLE_SOURCE,
): string {
  return source.replaceAll(PROTOTYPE_WEB_PAGE_BUNDLE_VERSION_MARK, packageVersion);
}
