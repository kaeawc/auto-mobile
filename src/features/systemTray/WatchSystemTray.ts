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
const pageSignature = (observation: ObserveResult) =>
  JSON.stringify([
    watchNotifications(observation.viewHierarchy).map((card) => [
      cardIdentity(card),
      card.element.bounds,
    ]),
    watchClearAll(observation.viewHierarchy)?.bounds,
  ]);

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

  async execute(args: SystemTrayArgs): Promise<SystemTrayOutcome> {
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
      return result;
    } finally {
      const controller = new AbortController();
      const restored = await raceWithDeadline(
        () => this.restore(initiallyOpen, controller.signal),
        {
          timer: getSystemTrayDependencies().timer,
          timeoutMs: timeout,
          label: "Watch notification stream restoration",
          onTimeout: () => controller.abort(),
        },
      );
      if (result) {
        result.payload.observation = restored;
      }
    }
  }

  private async toggle(action: "open" | "close", timeout: number): Promise<SystemTrayOutcome> {
    const result =
      action === "open"
        ? await ensureSystemTrayOpen(this.device, timeout, { signal: this.signal })
        : await ensureSystemTrayClosed(this.device, timeout, undefined, this.signal);
    const success = result.skipped || ("opened" in result ? result.opened : result.closed);
    return outcome(
      {
        message: `${action === "open" ? "Opened" : "Closed"} watch notification stream`,
        ...result,
      },
      success,
    );
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
    let previousPage = "";
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
      const signature = JSON.stringify(
        visible.map((card) => [cardIdentity(card), card.element.bounds]),
      );
      // Preserve identical cards within a page. Cross-page overlap is deliberately conservative:
      // without captured stable IDs, keep duplicates rather than silently lose notifications.
      if (signature !== previousPage) {
        cards = [...cards, ...matching];
      }
      const atEnd = signature === previousPage || !!watchClearAll(observation.viewHierarchy);
      if (atEnd && ["list", "clearAll"].includes(args.action)) {
        return this.scanResult(args, scope, cards, observation);
      }
      if (getSystemTrayDependencies().timer.now() >= deadline) {
        break;
      }
      previousPage = signature;
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

  /** Scroll toward the top until the visible page stops changing. */
  private async rewind(observation: ObserveResult, deadline: number): Promise<ObserveResult> {
    let previous = pageSignature(observation);
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
      const signature = pageSignature(observation);
      if (signature === previous) {
        break;
      }
      previous = signature;
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
    const before = watchNotifications(observation.viewHierarchy).filter(sameCard).length;
    if (
      !watchStreamRoot(next.viewHierarchy) ||
      watchNotifications(next.viewHierarchy).some(
        (remaining) => cardIdentity(remaining) === cardIdentity(card),
      ) ||
      // An ongoing card that refuses the swipe may still rewrite its body (progress, position),
      // so a surviving same-app/title card is not a removal.
      watchNotifications(next.viewHierarchy).filter(sameCard).length >= before
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
