import { ActionableError, type BootedDevice, type Element, type ObserveResult } from "../../models";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import {
  parseActiveNotificationKeysForApp,
  parseDumpsysNotificationRecords,
  type DumpsysNotificationRecord,
} from "./notificationDumpsys";
import { readActiveNotificationKeysForApp } from "./helpers/listing";
import { createNotificationUIDetector } from "./createNotificationUIDetector";
import { getSystemTrayDependencies, resolveUniqueTrayAppLabel } from "./helpers/dependencies";
import {
  ensureSystemTrayClosed,
  ensureSystemTrayOpen,
  observeSystemTray,
  resolveSystemTrayAwaitTimeout,
  sleep,
} from "./helpers/runtime";
import {
  watchCardMatches,
  watchClearAll,
  watchExpandedTarget,
  watchNotifications,
  watchCardClipped,
  watchRevealedDismiss,
  watchStreamRoot,
  isWearHierarchy,
  type WatchNotification,
} from "./helpers/watchHierarchy";
import type { SystemTrayOutcome } from "./SystemTray";
import type { SystemTrayArgs, SystemTrayNotificationArgs } from "./systemTrayTypes";

const MAX_STREAM_PAGES = 20;
const POLL_MS = 250;
const MAX_SETTLE_READS = 6;
const SETTLE_MS = 500;

const outcome = (payload: Record<string, unknown>, success = true): SystemTrayOutcome => ({
  payload: { ...payload, success },
  isError: !success,
});
const listedCard = (card: WatchNotification, appId?: string) => ({
  id: null,
  appId,
  appLabel: card.appLabel,
  title: card.title,
  body: card.body,
  texts: card.texts,
  bounds: card.element.bounds,
  actions: [],
  inGroup: false,
  ownership: "header",
});
const cardIdentity = (card: WatchNotification) =>
  JSON.stringify([card.appLabel, card.title, card.body]);
const visibleCards = (observation: ObserveResult, key: (card: WatchNotification) => unknown) =>
  JSON.stringify([
    watchNotifications(observation.viewHierarchy).map((card) => [key(card), card.element.bounds]),
    watchClearAll(observation.viewHierarchy)?.bounds,
  ]);
/** Every visible card's full identity; the forward scan never drops a distinct card. */
const pageSignature = (observation: ObserveResult) => visibleCards(observation, cardIdentity);
/** Card layout without bodies, which an ongoing card rewrites in place (progress, position). */
const cardPositions = (observation: ObserveResult) =>
  visibleCards(observation, (card) => [card.appLabel, card.title]);
const identityCount = (cards: WatchNotification[], card: WatchNotification) =>
  cards.filter((other) => cardIdentity(other) === cardIdentity(card)).length;
/**
 * Whether an active record shows this card: the card's title is one of the record's titles, and
 * each body line appears in one of its bodies (a trailing ellipsis from truncation is ignored).
 */
const recordShowsCard = (record: DumpsysNotificationRecord, card: WatchNotification) =>
  card.title !== null &&
  record.titles.includes(card.title) &&
  (card.body ?? "")
    .split("\n")
    .map((line) => line.replace(/(?:…|\.\.\.)$/, ""))
    .filter((line) => line.length > 0)
    .every((line) => record.bodies.some((body) => body.includes(line)));
/** Fallback dismissal check from visible cards alone, when no active inventory is readable. */
const visiblyRemoved = (card: WatchNotification, before: ObserveResult, after: ObserveResult) => {
  const sameCard = (other: WatchNotification) =>
    other.appLabel === card.appLabel && other.title === card.title;
  const visibleBefore = watchNotifications(before.viewHierarchy);
  const visibleAfter = watchNotifications(after.viewHierarchy);
  return (
    // Identical duplicates are legal: one identical card must disappear, not all of them.
    identityCount(visibleAfter, card) < identityCount(visibleBefore, card) &&
    // An ongoing card that refuses the swipe may still rewrite its body (progress, position),
    // so a surviving same-app/title card is not a removal.
    visibleAfter.filter(sameCard).length < visibleBefore.filter(sameCard).length
  );
};

/** Whether the matched card can take its action now, or must first be scrolled into full view. */
const actionable = (
  action: SystemTrayArgs["action"],
  card: WatchNotification,
  observation: ObserveResult,
  atEnd: boolean,
) =>
  action !== "list" &&
  (action !== "dismiss" || atEnd || !watchCardClipped(observation.viewHierarchy, card));

const toggleMessage = (action: "open" | "close", changed: boolean, skipped: boolean): string => {
  if (skipped) {
    return `Watch notification stream was already ${action === "open" ? "open" : "closed"}`;
  }
  if (changed) {
    return `${action === "open" ? "Opened" : "Closed"} watch notification stream`;
  }
  return action === "open"
    ? "Watch notification stream did not appear after the open gesture"
    : "Watch notification stream is still showing after Back";
};

/** A watch action's outcome plus the observation terminal evidence is captured from. */
export interface WatchSystemTrayResult {
  outcome: SystemTrayOutcome;
  observation: ObserveResult | undefined;
}

interface WatchScope {
  criteria: SystemTrayNotificationArgs;
  label: string | undefined;
  deadline: number;
  dismissedCount: number;
}

/** Dispatched only for Android devices whose existing formFactor signal is watch. */
export class WatchSystemTray {
  private expandedByUs = false;
  constructor(
    private readonly device: BootedDevice,
    private readonly signal?: AbortSignal,
  ) {}

  private read(signal = this.signal): Promise<ObserveResult> {
    const deps = getSystemTrayDependencies();
    return observeSystemTray(deps.observeScreenFactory(this.device), 0, signal, true);
  }

  private command(command: string, signal = this.signal): Promise<unknown> {
    throwIfAborted(signal);
    return awaitWhileRequestIsLive(
      getSystemTrayDependencies().adbFactory(this.device).executeCommand(command, { signal }),
      signal,
    );
  }

  private async tap(element: Element, observation: ObserveResult): Promise<void> {
    // Reject clipped/off-circle targets rather than tapping an invisible corner of a round display.
    const { width, height } = observation.screenSize;
    const { left, top, right, bottom } = element.bounds;
    const x = Math.floor((left + right) / 2);
    const y = Math.floor((top + bottom) / 2);
    if (
      x < 0 ||
      y < 0 ||
      x >= width ||
      y >= height ||
      Math.hypot(x - width / 2, y - height / 2) >= Math.min(width, height) / 2
    ) {
      throw new ActionableError(
        "Watch notification target is outside the visible circle; scroll it into view.",
      );
    }
    const detector = createNotificationUIDetector(
      this.device,
      getSystemTrayDependencies,
      this.signal,
    );
    await detector.tapElement(element);
  }

  private async appLabel(criteria: SystemTrayNotificationArgs): Promise<string | undefined> {
    if (!criteria.appId) {
      return undefined;
    }
    const deps = getSystemTrayDependencies();
    const inventory = await awaitWhileRequestIsLive(
      deps.appInventoryFactory(this.device).executeDetailedResult(this.signal),
      this.signal,
    );
    if (!inventory.successful) {
      throw new ActionableError(
        "Cannot verify watch notification ownership: installed-app inventory is incomplete.",
      );
    }
    const appIds = [
      ...new Set(
        [...Object.values(inventory.apps.profiles).flat(), ...inventory.apps.system].map(
          (app) => app.packageName,
        ),
      ),
    ];
    if (!appIds.includes(criteria.appId)) {
      throw new ActionableError(`App ${criteria.appId} is not installed.`);
    }
    return resolveUniqueTrayAppLabel(this.device, criteria.appId, appIds, { signal: this.signal });
  }

  async execute(args: SystemTrayArgs): Promise<WatchSystemTrayResult> {
    const timeout = resolveSystemTrayAwaitTimeout(args.awaitTimeout);
    if (args.action === "open" || args.action === "close") {
      return this.toggle(args.action, timeout);
    }
    const criteria = args.notification ?? {};
    if (["list", "clearAll"].includes(args.action) && !criteria.appId) {
      throw new ActionableError(`${args.action} action requires notification.appId`);
    }
    const label = await this.appLabel(criteria);
    const initial = await this.read();
    const initiallyOpen = !!watchStreamRoot(initial.viewHierarchy);
    let result: SystemTrayOutcome | undefined;
    let restored: ObserveResult | undefined;
    try {
      const opened = await ensureSystemTrayOpen(this.device, timeout, {
        signal: this.signal,
        initialObservation: initial,
      });
      if (!opened.opened && !opened.skipped) {
        throw new ActionableError(
          "Could not open the watch notification stream from the current screen. Return to the watch face and retry.",
        );
      }
      const deadline = getSystemTrayDependencies().timer.now() + timeout;
      const observation = opened.observation ?? (await this.read());
      // The scan only moves toward the end, so a stream left scrolled down must start at the top.
      const top = initiallyOpen ? await this.rewind(observation, deadline) : observation;
      result = top
        ? await this.run(args, { criteria, label, deadline, dismissedCount: 0 }, top)
        : outcome(
            {
              code: "notification_not_found",
              message:
                "Could not scroll the watch notification stream back to its top before the scan limit or deadline",
              observation,
            },
            false,
          );
    } finally {
      const controller = new AbortController();
      restored = await raceWithDeadline(() => this.restore(initiallyOpen, controller.signal), {
        timer: getSystemTrayDependencies().timer,
        timeoutMs: timeout,
        label: "Watch notification stream restoration",
        onTimeout: () => controller.abort(),
      });
      if (result) {
        result.payload.observation = restored;
      }
    }
    return { outcome: result, observation: restored };
  }

  private async toggle(action: "open" | "close", timeout: number): Promise<WatchSystemTrayResult> {
    const result =
      action === "open"
        ? await ensureSystemTrayOpen(this.device, timeout, { signal: this.signal })
        : await ensureSystemTrayClosed(this.device, timeout, undefined, this.signal);
    const changed = "opened" in result ? result.opened : result.closed;
    const success = result.skipped || changed;
    return {
      outcome: outcome(
        { message: toggleMessage(action, changed, result.skipped), ...result },
        success,
      ),
      observation: result.observation,
    };
  }

  private async restore(initiallyOpen: boolean, signal: AbortSignal): Promise<ObserveResult> {
    // Cleanup deliberately ignores request cancellation, as on the phone clear path.
    let current = await this.readWithoutCancellation(signal);
    if (
      this.expandedByUs &&
      !watchStreamRoot(current.viewHierarchy) &&
      isWearHierarchy(current.viewHierarchy)
    ) {
      await this.commandWithoutCancellation("shell input keyevent 4", signal);
      current = await this.readWithoutCancellation(signal);
    }
    if (!initiallyOpen && watchStreamRoot(current.viewHierarchy)) {
      await this.commandWithoutCancellation("shell input keyevent 4", signal);
      current = await this.readWithoutCancellation(signal);
      if (watchStreamRoot(current.viewHierarchy)) {
        throw new ActionableError(
          "Watch notification stream did not close after returning to the previous screen.",
        );
      }
    }
    return current;
  }

  private readWithoutCancellation(signal: AbortSignal): Promise<ObserveResult> {
    return observeSystemTray(
      getSystemTrayDependencies().observeScreenFactory(this.device),
      0,
      signal,
      true,
    );
  }

  private commandWithoutCancellation(command: string, signal: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    return awaitWhileRequestIsLive(
      getSystemTrayDependencies().adbFactory(this.device).executeCommand(command, { signal }),
      signal,
    );
  }

  private async run(
    args: SystemTrayArgs,
    scope: WatchScope,
    observation: ObserveResult,
  ): Promise<SystemTrayOutcome> {
    const { criteria, label, deadline } = scope;
    let cards: WatchNotification[] = [];
    let previous: ObserveResult | undefined;
    for (let page = 0; page < MAX_STREAM_PAGES; page++) {
      if (!watchStreamRoot(observation.viewHierarchy)) {
        throw new ActionableError("Watch notification stream is not readable.");
      }
      const visible = watchNotifications(observation.viewHierarchy);
      const matching = visible.filter((card) => watchCardMatches(card, criteria, label));
      const clear = await this.globalClearTarget(args, observation);
      if (clear) {
        await this.tap(clear.element, observation);
        // Cards dismissed one by one earlier already left the inventory `clear.count` reads.
        return this.verifyClearAll(deadline, clear.appId, clear.count + scope.dismissedCount);
      }
      // Strict: a different ongoing card that scrolled in must never be mistaken for this page.
      const unmoved =
        previous !== undefined && pageSignature(previous) === pageSignature(observation);
      const atEnd = unmoved || !!watchClearAll(observation.viewHierarchy);
      // A swipe needs the card's true extent: scroll a clipped match into full view first and act
      // on its bounds from the re-read, unless the stream cannot scroll any further.
      const target = matching[0];
      if (target && actionable(args.action, target, observation, atEnd)) {
        return this.act(args, target, observation, scope);
      }
      // Preserve identical cards within a page. Cross-page overlap is deliberately conservative:
      // without captured stable IDs, keep duplicates rather than silently lose notifications.
      if (!unmoved) {
        cards = [...cards, ...matching];
      }
      if (atEnd && ["list", "clearAll"].includes(args.action)) {
        return this.scanResult(args, scope, cards, observation);
      }
      if (getSystemTrayDependencies().timer.now() >= deadline) {
        break;
      }
      previous = observation;
      observation = await this.nextPage(observation, atEnd, deadline);
    }
    return outcome(
      {
        code: "notification_not_found",
        message: "Notification not found before the watch stream scan limit or deadline",
        observation,
      },
      false,
    );
  }

  private async globalClearTarget(
    args: SystemTrayArgs,
    observation: ObserveResult,
  ): Promise<{ element: Element; appId: string; count: number } | undefined> {
    const criteria = args.notification;
    if (args.action !== "clearAll" || !criteria?.appId || criteria.title || criteria.body) {
      return undefined;
    }
    const element = watchClearAll(observation.viewHierarchy);
    if (!element) {
      return undefined;
    }
    const { stdout } = await awaitWhileRequestIsLive(
      getSystemTrayDependencies()
        .adbFactory(this.device)
        .executeCommand("shell dumpsys notification --noredact", {
          maxBuffer: DUMPSYS_MAX_BUFFER,
          signal: this.signal,
        }),
      this.signal,
    );
    const keys = parseActiveNotificationKeysForApp(stdout, criteria.appId);
    const records = parseDumpsysNotificationRecords(stdout);
    // Clear all is global. Use it only with a complete active inventory owned solely by this app.
    // Unknown, mixed-app or content-scoped clears must dismiss individual cards instead.
    return keys && keys.length > 0 && records.every((record) => record.pkg === criteria.appId)
      ? { element, appId: criteria.appId, count: keys.length }
      : undefined;
  }

  private scanResult(
    args: SystemTrayArgs,
    scope: WatchScope,
    cards: WatchNotification[],
    observation: ObserveResult,
  ): SystemTrayOutcome {
    const { criteria } = scope;
    if (args.action === "list") {
      return outcome({
        message: `Listed ${cards.length} notifications for ${criteria.appId}`,
        notifications: cards.map((card) => listedCard(card, criteria.appId)),
        observation,
      });
    }
    if (args.action === "clearAll" && cards.length === 0) {
      return outcome({
        message: "Cleared matching watch notifications",
        dismissedCount: scope.dismissedCount,
        observation,
      });
    }
    return outcome(
      {
        code: "dismissal_unconfirmed",
        message: "No watch Clear all control was available",
        observation,
      },
      false,
    );
  }

  /**
   * Whether a swipe moved the stream from `before` to `after`. When only a body differs, re-read
   * without scrolling: a stable body is a different card from the same app and title at the same
   * snapped bounds ("moved"); a body that keeps changing on its own is "ambiguous", since it is
   * either an ongoing card updating in place or a different ongoing card that scrolled in.
   */
  private async swipeProgress(
    before: ObserveResult,
    after: ObserveResult,
    deadline: number,
  ): Promise<"moved" | "unmoved" | "ambiguous"> {
    if (pageSignature(before) === pageSignature(after)) {
      return "unmoved";
    }
    if (cardPositions(before) !== cardPositions(after)) {
      return "moved";
    }
    await sleep(
      Math.min(POLL_MS, Math.max(0, deadline - getSystemTrayDependencies().timer.now())),
      this.signal,
    );
    const settled = await this.read();
    return cardPositions(settled) === cardPositions(after) &&
      pageSignature(settled) !== pageSignature(after)
      ? "ambiguous"
      : "moved";
  }

  /**
   * Scroll toward the top until the visible cards stop moving, or `undefined` when the top was not
   * reached. Overshooting the top is harmless, so an ambiguous page only ends the rewind when the
   * next swipe is ambiguous too.
   */
  private async rewind(
    observation: ObserveResult,
    deadline: number,
  ): Promise<ObserveResult | undefined> {
    let previous = observation;
    let ambiguous = 0;
    for (let page = 0; page < MAX_STREAM_PAGES; page++) {
      if (getSystemTrayDependencies().timer.now() >= deadline) {
        return undefined;
      }
      const { width, height } = observation.screenSize;
      await this.command(
        `shell input swipe ${Math.floor(width / 2)} ${Math.floor(height * 0.25)} ${Math.floor(width / 2)} ${Math.floor(height * 0.75)} 500`,
      );
      await sleep(
        Math.min(POLL_MS, Math.max(0, deadline - getSystemTrayDependencies().timer.now())),
        this.signal,
      );
      observation = await this.read();
      const progress = await this.swipeProgress(previous, observation, deadline);
      ambiguous = progress === "ambiguous" ? ambiguous + 1 : 0;
      if (progress === "unmoved" || ambiguous >= 2) {
        return observation;
      }
      previous = observation;
    }
    return undefined;
  }

  private async nextPage(
    observation: ObserveResult,
    atEnd: boolean,
    deadline: number,
  ): Promise<ObserveResult> {
    if (!atEnd) {
      const { width, height } = observation.screenSize;
      await this.command(
        `shell input swipe ${Math.floor(width / 2)} ${Math.floor(height * 0.75)} ${Math.floor(width / 2)} ${Math.floor(height * 0.25)} 500`,
      );
    }
    await sleep(
      Math.min(POLL_MS, Math.max(0, deadline - getSystemTrayDependencies().timer.now())),
      this.signal,
    );
    return this.read();
  }

  private async act(
    args: SystemTrayArgs,
    card: WatchNotification,
    observation: ObserveResult,
    scope: WatchScope,
  ): Promise<SystemTrayOutcome> {
    if (args.action === "find") {
      return outcome({
        message: "Found notification in watch stream",
        ...listedCard(card, args.notification?.appId),
        observation,
      });
    }
    if (args.action === "tap") {
      return this.tapNotification(args, card, observation);
    }
    return this.dismissNotification(args, card, observation, scope);
  }

  private async tapNotification(
    args: SystemTrayArgs,
    card: WatchNotification,
    observation: ObserveResult,
  ): Promise<SystemTrayOutcome> {
    await this.tap(card.element, observation);
    this.expandedByUs = true;
    await sleep(POLL_MS, this.signal);
    const expanded = await this.read();
    const text = args.notification?.tapActionLabel ?? card.title ?? card.body;
    const target = text ? watchExpandedTarget(expanded.viewHierarchy, text) : undefined;
    if (!target) {
      throw new ActionableError(
        "Watch notification expanded target is not available. Re-observe the expanded notification and use an explicit clickable content or action label.",
      );
    }
    await this.tap(target, expanded);
    return outcome({ message: "Tapped watch notification", observation: await this.read() });
  }

  private async dismissNotification(
    args: SystemTrayArgs,
    card: WatchNotification,
    observation: ObserveResult,
    scope: WatchScope,
  ): Promise<SystemTrayOutcome> {
    const target = await this.settled(card, observation, scope);
    const { next, removed } = await this.swipeAway(
      target.card,
      target.observation,
      args.notification?.appId,
      scope,
    );
    if (!removed) {
      return outcome(
        {
          code: "dismissal_unconfirmed",
          message: "Could not confirm watch notification dismissal",
          observation: next,
        },
        false,
      );
    }
    if (args.action === "clearAll") {
      if (
        getSystemTrayDependencies().timer.now() >= scope.deadline ||
        scope.dismissedCount >= MAX_STREAM_PAGES
      ) {
        return outcome(
          {
            code: "dismissal_unconfirmed",
            message: "Watch notification clear deadline reached",
            observation: next,
          },
          false,
        );
      }
      return this.run(args, { ...scope, dismissedCount: scope.dismissedCount + 1 }, next);
    }
    return outcome({ message: "Dismissed notification", dismissedCount: 1, observation: next });
  }

  /**
   * The card the action targets in `observation`: the first visible match of the criteria, which
   * is how the scan picked it. Cards carry no stable key and a CtrlProxy capture exposes their
   * title and body only as text lines, so a card is relocated by its criteria, never by position.
   */
  private locate(observation: ObserveResult, scope: WatchScope): WatchNotification | undefined {
    return watchNotifications(observation.viewHierarchy).find((card) =>
      watchCardMatches(card, scope.criteria, scope.label),
    );
  }

  /**
   * Re-read until `card`'s bounds hold still between two reads. A scroll or the end-of-stream
   * spring-back keeps animating after the swipe that caused it, so the bounds of the read that
   * found the card can be stale; a swipe aimed at them misses the card and leaves the stream
   * (#17331). Returns the card and observation of the settled read.
   */
  private async settled(
    card: WatchNotification,
    observation: ObserveResult,
    scope: WatchScope,
  ): Promise<{ card: WatchNotification; observation: ObserveResult }> {
    let current = { card, observation };
    for (let attempt = 0; attempt < MAX_SETTLE_READS; attempt++) {
      await sleep(SETTLE_MS, this.signal);
      const next = await this.read();
      const moved = this.locate(next, scope);
      if (!moved) {
        throw new ActionableError(
          "The watch notification left view while the stream settled. Retry the action.",
        );
      }
      const still =
        JSON.stringify(moved.element.bounds) === JSON.stringify(current.card.element.bounds);
      current = { card: moved, observation: next };
      if (still) {
        return current;
      }
    }
    throw new ActionableError(
      "The watch notification stream kept moving. Retry the action once it is still.",
    );
  }

  /** Swipe `card` away and report whether its removal is confirmed. */
  private async swipeAway(
    card: WatchNotification,
    observation: ObserveResult,
    appId: string | undefined,
    scope: WatchScope,
  ): Promise<{ next: ObserveResult; removed: boolean }> {
    const { left, top, right, bottom } = card.element.bounds;
    const before = appId ? await this.inventory(appId, card) : undefined;
    // A horizontal swipe either dismisses the card or reveals its X button (Wear OS 7).
    await this.command(
      `shell input swipe ${Math.floor((left + right) / 2)} ${Math.floor((top + bottom) / 2)} ${right - 1} ${Math.floor((top + bottom) / 2)} 300`,
    );
    await sleep(POLL_MS, this.signal);
    let next = await this.read();
    // Wear OS 7 only reveals the X and settings buttons; tapping the X dismisses the card.
    // Tap only the X on the swiped card's own row: if the stream moved under the swipe, another
    // card's buttons are showing and tapping them would dismiss the wrong notification (#17331).
    const swiped = this.locate(next, scope);
    const revealed = swiped && watchRevealedDismiss(next.viewHierarchy, swiped);
    if (revealed) {
      await this.tap(revealed, next);
      await sleep(POLL_MS, this.signal);
      next = await this.read();
    }
    if (!watchStreamRoot(next.viewHierarchy)) {
      return { next, removed: false };
    }
    const after = appId && before ? await this.inventory(appId, card) : undefined;
    if (!before || !after || before.matching === 0) {
      return { next, removed: visiblyRemoved(card, observation, next) };
    }
    // An identical card scrolling into view cannot fake a removed key, a refused card that
    // rewrites its text keeps its key, and another notification of the app expiring meanwhile
    // removes a key but not one showing the swiped card's title and body.
    return {
      next,
      removed:
        before.keys.some((key) => !after.keys.includes(key)) && after.matching < before.matching,
    };
  }

  /**
   * The app's active notification keys, and how many of its active records show the card's title
   * and body, or `undefined` when the dump is not trustworthy enough for before/after accounting.
   */
  private async inventory(
    appId: string,
    card: WatchNotification,
  ): Promise<{ keys: string[]; matching: number } | undefined> {
    const { stdout } = await awaitWhileRequestIsLive(
      getSystemTrayDependencies()
        .adbFactory(this.device)
        .executeCommand("shell dumpsys notification --noredact", {
          maxBuffer: DUMPSYS_MAX_BUFFER,
          signal: this.signal,
        }),
      this.signal,
    );
    const keys = parseActiveNotificationKeysForApp(stdout, appId);
    if (!keys) {
      return undefined;
    }
    const matching = parseDumpsysNotificationRecords(stdout).filter(
      (record) => record.pkg === appId && recordShowsCard(record, card),
    ).length;
    return { keys, matching };
  }

  private async verifyClearAll(
    deadline: number,
    appId: string,
    expectedCount: number,
  ): Promise<SystemTrayOutcome> {
    await sleep(
      Math.min(POLL_MS, Math.max(0, deadline - getSystemTrayDependencies().timer.now())),
      this.signal,
    );
    const observation = await this.read();
    const keys = await readActiveNotificationKeysForApp(this.device, appId, this.signal);
    const success = keys !== undefined && keys.length === 0;
    return outcome(
      {
        message: success
          ? "Cleared watch notifications"
          : "Could not confirm watch notification clear",
        dismissedCount: success ? expectedCount : 0,
        observation,
      },
      success,
    );
  }
}
