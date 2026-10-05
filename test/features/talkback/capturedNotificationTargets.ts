import capture from "../../fixtures/observe/ctrlproxy-headerless-two-notification-group-expanded.json";
import type { ViewHierarchyResult } from "../../../src/models";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";

// Existing device capture: the notification list repeats native row IDs.
export const notificationHierarchy: ViewHierarchyResult = capture.viewHierarchy;
export const notificationRows = new SearchableHierarchy()
  .project(notificationHierarchy)
  .filter((node) => node.nativeId === "com.android.systemui:id/expandableNotificationRow")
  .flatMap((node) => (node.element ? [node.element] : []));
