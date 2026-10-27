/** Shared system tray API. Implementations live in the cohesive helper modules below. */
export {
  type SystemTrayObserver,
  type SystemTrayAdb,
  type SystemTrayIosClient,
  type SystemTrayDependencies,
  getSystemTrayDependencies,
  setSystemTrayDependencies,
  resetSystemTrayDependencies,
  resolveAppLabel,
  resolveUniqueTrayAppLabel,
} from "./helpers/dependencies";
export {
  EXPAND_GROUP_SETTLE_MS,
  resolveSystemTrayAwaitTimeout,
  observeSystemTray,
  observeSystemTrayAfterTap,
  captureSystemTrayTerminalEvidence,
  waitForSystemTrayOpen,
  ensureSystemTrayOpen,
  ensureSystemTrayClosed,
  waitForNotificationMatch,
  tapElement,
  swipeElement,
} from "./helpers/runtime";
export {
  createSubHierarchy,
  isMatchInCollapsedGroup,
  getNotificationGroupHeader,
  getNotificationGroupChildRows,
  resolveNotificationGroupExpansionState,
  collectNotificationCandidates,
  extractNodeTextCandidates,
  findHeaderAppLabel,
} from "./helpers/hierarchy";
export {
  expandNotificationGroup,
  expandAndRematchIfCollapsed,
  isSwipeTargetIsolatedFromGroup,
} from "./helpers/groupExpansion";
export { resolveNotificationTapElement, resolveNotificationSwipeElement } from "./helpers/matching";
export {
  captureNotificationDismissBaseline,
  verifyNotificationDismissed,
  clearMatchingSystemTrayNotifications,
  clearIosSystemTrayNotifications,
  readClearAllTerminalObservation,
} from "./helpers/dismissal";
export {
  listSystemTrayNotifications,
  listSystemTrayNotificationsForClear,
  readActiveNotificationKeysForApp,
} from "./helpers/listing";
export { retryTransientPreSwipe } from "./helpers/transientRetry";
export { TransientPreSwipeError } from "./TransientPreSwipeError";
export { NotificationShadeNotOpenError } from "./systemTrayNotificationList";
