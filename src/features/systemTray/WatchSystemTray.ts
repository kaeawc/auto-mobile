import { ActionableError, type BootedDevice, type Element, type ObserveResult } from "../../models";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import {
  parseActiveNotificationKeysForApp,
  parseDumpsysNotificationRecords,
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
  watchStreamRoot,
  isWearHierarchy,
  type WatchNotification,
} from "./helpers/watchHierarchy";
import type { SystemTrayOutcome } from "./SystemTray";
import type { SystemTrayArgs, SystemTrayNotificationArgs } from "./systemTrayTypes";

const MAX_STREAM_PAGES = 20;
const POLL_MS = 250;

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
      let observation = opened.observation ?? (await this.read());
      if (initiallyOpen) {
        // The scan only moves toward the end, so a stream left scrolled down must start at the top.
        observation = await this.rewind(observation, deadline);
      }
      result = await this.run(args, { criteria, label, deadline, dismissedCount: 0 }, observation);
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
    const success = result.skipped || ("opened" in result ? result.opened : result.closed);
    return {
      outcome: outcome(
        {
          message: `${action === "open" ? "Opened" : "Closed"} watch notification stream`,
          ...result,
        },
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
      if (args.action !== "list" && matching[0]) {
        return this.act(args, matching[0], observation, scope);
      }
      const unmoved = previous ? await this.unmoved(previous, observation, deadline) : false;
      // Preserve identical cards within a page. Cross-page overlap is deliberately conservative:
      // without captured stable IDs, keep duplicates rather than silently lose notifications.
      if (!unmoved) {
        cards = [...cards, ...matching];
      }
      const atEnd = unmoved || !!watchClearAll(observation.viewHierarchy);
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
   * Whether `after` shows the stream where `before` left it. When only a body differs, re-read
   * without scrolling: a body that keeps changing on its own is an ongoing card updating in place,
   * while a stable one is a different card from the same app and title at the same snapped bounds.
   */
  private async unmoved(
    before: ObserveResult,
    after: ObserveResult,
    deadline: number,
  ): Promise<boolean> {
    if (pageSignature(before) === pageSignature(after)) {
      return true;
    }
    if (cardPositions(before) !== cardPositions(after)) {
      return false;
    }
    await sleep(
      Math.min(POLL_MS, Math.max(0, deadline - getSystemTrayDependencies().timer.now())),
      this.signal,
    );
    const settled = await this.read();
    return (
      cardPositions(settled) === cardPositions(after) &&
      pageSignature(settled) !== pageSignature(after)
    );
  }

  /** Scroll toward the top until the visible cards stop moving. */
  private async rewind(observation: ObserveResult, deadline: number): Promise<ObserveResult> {
    let previous = observation;
    for (let page = 0; page < MAX_STREAM_PAGES; page++) {
      if (getSystemTrayDependencies().timer.now() >= deadline) {
        break;
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
      if (await this.unmoved(previous, observation, deadline)) {
        break;
      }
      previous = observation;
    }
    return observation;
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
    const { left, top, right, bottom } = card.element.bounds;
    // Wear dismisses a card with a horizontal swipe. This gesture still needs device verification.
    await this.command(
      `shell input swipe ${Math.floor((left + right) / 2)} ${Math.floor((top + bottom) / 2)} ${right - 1} ${Math.floor((top + bottom) / 2)} 300`,
    );
    await sleep(POLL_MS, this.signal);
    const next = await this.read();
    const sameCard = (other: WatchNotification) =>
      other.appLabel === card.appLabel && other.title === card.title;
    const visibleBefore = watchNotifications(observation.viewHierarchy);
    const visibleAfter = watchNotifications(next.viewHierarchy);
    if (
      !watchStreamRoot(next.viewHierarchy) ||
      // Identical duplicates are legal: one identical card must disappear, not all of them.
      identityCount(visibleAfter, card) >= identityCount(visibleBefore, card) ||
      // An ongoing card that refuses the swipe may still rewrite its body (progress, position),
      // so a surviving same-app/title card is not a removal.
      visibleAfter.filter(sameCard).length >= visibleBefore.filter(sameCard).length
    ) {
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
