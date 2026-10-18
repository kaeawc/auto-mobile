import type { ElementBounds } from "./ElementBounds";

export type MediaType = "image" | "video" | "loading" | "mixed";

export interface MediaView {
  viewId?: string;
  className: string;
  mediaType: MediaType;
  bounds: ElementBounds;
  contentDescription?: string;
  resourceId?: string;
  sourceUrl?: string;
  isLoading?: boolean;
}
