import type {
  KeyboardHierarchyCache,
  KeyboardHierarchyProvider,
  KeyboardHierarchyReadOptions,
} from "./Keyboard";
import { ViewHierarchyResult } from "../../models";
import { ViewHierarchy } from "../observe/ViewHierarchy";

export class DefaultKeyboardHierarchyProvider implements KeyboardHierarchyProvider {
  private viewHierarchy: Pick<ViewHierarchy, "getViewHierarchy">;
  private cache: KeyboardHierarchyCache;

  constructor(
    viewHierarchy: Pick<ViewHierarchy, "getViewHierarchy">,
    cache: KeyboardHierarchyCache,
  ) {
    this.viewHierarchy = viewHierarchy;
    this.cache = cache;
  }

  async getViewHierarchy(
    signal?: AbortSignal,
    options?: KeyboardHierarchyReadOptions,
  ): Promise<ViewHierarchyResult | null> {
    if (options?.forceFresh) {
      this.cache.invalidateCache();
    }
    return this.viewHierarchy.getViewHierarchy(undefined, {
      skipWaitForFresh: false,
      minTimestamp: 0,
      signal,
      timeoutMs: options?.timeoutMs,
    });
  }
}
