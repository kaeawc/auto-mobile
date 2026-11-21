// The prototype web page's entry (#16528): the library's `mount` plus a boot that draws the page's
// inlined options on load. `build.ts` writes its minified build to
// src/features/prototype/web/prototypeWebPageBundle.generated.ts, which the server inlines.
import { mount } from "../../../src/features/prototype/web/embed/prototypeWebMount";
import {
  bootPrototypeWebPage,
  PROTOTYPE_WEB_PAGE_HOST_SELECTOR,
  PROTOTYPE_WEB_PAGE_OPTIONS_SELECTOR,
} from "../../../src/features/prototype/web/embed/prototypeWebPageBoot";

bootPrototypeWebPage(
  {
    optionsText: () =>
      document.querySelector(PROTOTYPE_WEB_PAGE_OPTIONS_SELECTOR)?.textContent ?? null,
    host: () => document.querySelector<HTMLElement>(PROTOTYPE_WEB_PAGE_HOST_SELECTOR),
  },
  mount,
);
