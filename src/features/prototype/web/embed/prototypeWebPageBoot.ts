import type { PrototypeMountOptions } from "./prototypeWebMountState";

/** The page's inlined `mount` options: a JSON script the page bundle reads on load (#16528). */
export const PROTOTYPE_WEB_PAGE_OPTIONS_SELECTOR =
  'script[type="application/json"][data-prototype-page]';

/** The element the page bundle mounts into; its static still stays as the no-script fallback. */
export const PROTOTYPE_WEB_PAGE_HOST_SELECTOR = "[data-prototype-host]";

/** What the page bundle reads from the document: the browser's `document`, a fake in tests. */
export interface PrototypeWebPageDom<Host> {
  readonly optionsText: () => string | null;
  readonly host: () => Host | null;
}

/**
 * Mounts the page's inlined options on its host. `mount` draws into a shadow root, so the host's
 * static still is hidden, not removed. A page without either part draws nothing.
 */
export function bootPrototypeWebPage<Host, Handle>(
  dom: PrototypeWebPageDom<Host>,
  mountOn: (host: Host, options: PrototypeMountOptions) => Handle,
): Handle | undefined {
  const text = dom.optionsText();
  const host = dom.host();
  if (text === null || host === null) {
    return undefined;
  }
  return mountOn(host, JSON.parse(text) as PrototypeMountOptions);
}
