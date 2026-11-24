import type { Element } from "../../models/Element";

export const SHARE_SHEET_KINDS = [
  "android-intentresolver",
  "android-legacy",
  "ios-activity-view-controller",
] as const;

export interface ShareTarget {
  label: string;
  appId?: string;
  kind: "app" | "direct" | "action";
}

export interface ShareRow {
  target: ShareTarget;
  element: Element;
}
