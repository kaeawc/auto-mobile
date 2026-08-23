import type { Element } from "../../models/Element";
import { ElementBounds } from "../../models/ElementBounds";
import { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import { DefaultElementParser } from "../utility/ElementParser";
import type { ElementParser } from "../../utils/interfaces/ElementParser";

export type MediaType = "image" | "video" | "loading" | "mixed";
export type FlattenedElementEntry = {
  element: Element;
  index: number;
  depth: number;
  text?: string;
};

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

interface PatternSet {
  image: RegExp[];
  video: RegExp[];
  loading: RegExp[];
  mixed: RegExp[];
}

const androidPatterns: PatternSet = {
  image: [
    /ImageView$/i,
    /ShapeableImageView$/i,
    /GlideImageView/i,
    /FrescoDraweeView/i,
    /DraweeView/i,
    /PhotoView/i,
  ],
  video: [/VideoView$/i, /PlayerView$/i, /StyledPlayerView$/i, /SurfaceView$/i, /TextureView$/i],
  loading: [
    /ProgressBar$/i,
    /CircularProgressIndicator/i,
    /LinearProgressIndicator/i,
    /ShimmerFrameLayout/i,
    /ContentLoadingProgressBar/i,
  ],
  mixed: [],
};

const iosPatterns: PatternSet = {
  image: [/^UIImageView$/i],
  video: [/AVPlayerView/i, /AVPlayerViewController/i],
  loading: [/^UIActivityIndicatorView$/i, /^UIProgressView$/i],
  mixed: [/^WKWebView$/i],
};

function matchMediaType(className: string, patterns: PatternSet): MediaType | null {
  for (const type of ["image", "video", "loading", "mixed"] as const) {
    for (const pattern of patterns[type]) {
      if (pattern.test(className)) {
        return type;
      }
    }
  }
  return null;
}

function extractSourceUrl(extras: Record<string, string> | undefined): string | undefined {
  if (!extras) {
    return undefined;
  }
  for (const value of Object.values(extras)) {
    if (typeof value === "string" && /^https?:\/\//.test(value)) {
      return value;
    }
  }
  return undefined;
}

function boundsKey(b: ElementBounds): string {
  return `${b.left},${b.top},${b.right},${b.bottom}`;
}

export class IdentifyMediaViews {
  private parser: ElementParser;

  constructor(parser: ElementParser = new DefaultElementParser()) {
    this.parser = parser;
  }

  classify(
    viewHierarchy: ViewHierarchyResult,
    platform: "android" | "ios",
    flattenedEntries?: FlattenedElementEntry[],
  ): MediaView[] {
    const patterns = platform === "ios" ? iosPatterns : androidPatterns;
    const entries =
      flattenedEntries ??
      this.parser.flattenViewHierarchy(viewHierarchy, {
        includeWindows: true,
        windowOrder: "topmost-first",
      });

    const results: MediaView[] = [];
    const seenBounds = new Set<string>();

    for (const entry of entries) {
      const el = entry.element;
      const className = (el["class"] ?? el["className"] ?? "") as string;
      const role = el["role"] as string | undefined;

      const mediaType = matchMediaType(className, patterns);
      if (mediaType) {
        const key = boundsKey(el.bounds);
        seenBounds.add(key);
        results.push(this.toMediaView(el, className, mediaType));
        continue;
      }

      // iOS role-based detection for non-standard class names
      if (platform === "ios" && role === "image") {
        const key = boundsKey(el.bounds);
        if (!seenBounds.has(key)) {
          seenBounds.add(key);
          results.push(this.toMediaView(el, className, "image"));
        }
      }
    }

    return results;
  }

  private toMediaView(el: Element, className: string, mediaType: MediaType): MediaView {
    const view: MediaView = {
      className,
      mediaType,
      bounds: el.bounds,
    };

    const viewId = (el["view-id"] ?? el["viewId"]) as string | undefined;
    if (viewId) {
      view.viewId = viewId;
    }

    const contentDesc = (el["content-desc"] ?? el["contentDesc"]) as string | undefined;
    if (contentDesc) {
      view.contentDescription = contentDesc;
    }

    const resourceId = (el["resource-id"] ?? el["resourceId"]) as string | undefined;
    if (resourceId) {
      view.resourceId = resourceId;
    }

    const sourceUrl = extractSourceUrl(el["extras"] as Record<string, string> | undefined);
    if (sourceUrl) {
      view.sourceUrl = sourceUrl;
    }

    if (mediaType === "loading") {
      view.isLoading = true;
    }

    return view;
  }
}
