import { errorMessage } from "../../utils/describeUnknownError";
import { Socket } from "node:net";
import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { BaseSocketServer } from "./BaseSocketServer";
import { deviceSessionErrorFields, type DeviceSessionResolver } from "../deviceSessionResolver";
import {
  Subscriber,
  SubscriptionCommand,
  KeepaliveConfig,
  DEFAULT_KEEPALIVE_CONFIG,
} from "./SocketServerTypes";

/**
 * Response message for subscription operations.
 */
export interface SubscriptionResponse {
  id?: string;
  type: "subscription_response" | "ping" | "pong" | "error";
  success?: boolean;
  error?: string;
  timestamp?: number;
  subscriptionId?: string;
  code?: "BACKFILL_QUEUE_OVERFLOW" | "DEVICE_SESSION_SUPERSEDED_BY_RESTORE";
}

const MAX_BACKFILL_QUEUE = 1_000;

interface BackfillState<T> {
  pending: T[];
  pendingKeys: Set<string>;
  seen: Set<string>;
}

interface ConnectionState {
  lastActivity: number;
  drainPending: boolean;
}

/**
 * Abstract base class for push-based socket servers with subscriptions.
 * Handles subscriber management, keepalive, and push notifications.
 *
 * Subclasses implement:
 * - parseSubscriptionFilter(): Extract filter from subscription request
 * - createPushMessage(): Create push message for subscribers
 */
export abstract class PushSubscriptionSocketServer<TFilter, TPushData> extends BaseSocketServer {
  protected subscribers: Map<string, Subscriber<TFilter>> = new Map();
  // Standalone base-server tests need no registry; concrete device push servers
  // install their resolver and reject restore tombstones through this parser.
  protected deviceSessionResolver: DeviceSessionResolver | null = null;
  private connections: Map<Socket, ConnectionState> = new Map();
  private readonly backfills = new Map<string, BackfillState<TPushData>>();
  private subscriptionCounter = 0;
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  protected readonly keepaliveConfig: KeepaliveConfig;

  constructor(
    socketPath: string,
    timer: Timer = defaultTimer,
    serverName: string = "Push",
    keepaliveConfig: KeepaliveConfig = DEFAULT_KEEPALIVE_CONFIG,
  ) {
    super(socketPath, timer, serverName);
    this.keepaliveConfig = keepaliveConfig;
  }

  /**
   * Called when the server starts. Starts keepalive timer.
   */
  protected onServerStarted(): void {
    this.startKeepalive();
  }

  /**
   * Called before the server closes. Stops keepalive and cleans up subscribers.
   */
  protected onServerClosing(): void {
    this.stopKeepalive();

    for (const socket of this.connections.keys()) {
      try {
        socket.end();
      } catch (error) {
        // Peers may disconnect before shutdown; subscriber state is cleared below.
        logger.debug(`Push socket shutdown close failed: ${errorMessage(error)}`);
      }
    }
    this.subscribers.clear();
    this.connections.clear();
    this.backfills.clear();
  }

  /**
   * Start the keepalive timer.
   */
  protected startKeepalive(): void {
    if (this.keepaliveInterval) {
      return;
    }

    this.keepaliveInterval = this.timer.setInterval(() => {
      this.checkKeepalive();
    }, this.keepaliveConfig.intervalMs);
  }

  /**
   * Stop the keepalive timer.
   */
  protected stopKeepalive(): void {
    if (this.keepaliveInterval) {
      this.timer.clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  /**
   * Check keepalive for all connections, removing every subscription for dead connections.
   */
  protected checkKeepalive(): void {
    const now = this.timer.now();
    const deadSockets = new Set<Socket>();

    this.ensureConnectionStates();
    for (const [socket, connection] of this.connections) {
      if (socket.destroyed) {
        logger.info(`[${this.serverName}] Connection socket destroyed, removing subscriptions`);
        deadSockets.add(socket);
        continue;
      }

      const timeSinceActivity = now - connection.lastActivity;
      if (timeSinceActivity > this.keepaliveConfig.timeoutMs) {
        logger.warn(`[${this.serverName}] Connection timed out, removing subscriptions`);
        deadSockets.add(socket);
        try {
          socket.destroy();
        } catch (error) {
          // A timed-out peer may already be gone; its subscriptions are removed below.
          logger.debug(`Push socket timeout cleanup failed: ${errorMessage(error)}`);
        }
        continue;
      }

      // Send ping
      const pingMessage: SubscriptionResponse = {
        type: "ping",
        timestamp: now,
      };
      try {
        const ok = this.sendJson(socket, pingMessage);
        if (!ok) {
          this.armDrainListener(socket);
        }
      } catch (error) {
        logger.warn(`[${this.serverName}] Failed to ping connection: ${error}`);
        deadSockets.add(socket);
        try {
          socket.destroy();
        } catch (error) {
          // The failed peer is retired below even if its socket has already closed.
          logger.debug(`Push socket failed-peer cleanup failed: ${errorMessage(error)}`);
        }
      }
    }

    for (const socket of deadSockets) {
      this.removeSubscribersForSocket(socket);
    }
  }

  /**
   * Process a single line of input. Handles subscribe/unsubscribe/pong commands.
   */
  protected async processLine(socket: Socket, line: string): Promise<void> {
    const request = this.parseJson<SubscriptionCommand & Record<string, unknown>>(line);

    if (!request) {
      const errorResponse: SubscriptionResponse = {
        type: "error",
        success: false,
        error: "Invalid JSON",
      };
      this.sendJson(socket, errorResponse);
      return;
    }

    try {
      switch (request.command) {
        case "subscribe":
          await this.handleSubscribe(socket, request);
          break;
        case "unsubscribe":
          await this.handleUnsubscribe(socket, request);
          break;
        case "pong":
          this.handlePong(socket);
          break;
        default:
          throw new Error(`Unknown command: ${request.command}`);
      }
    } catch (error) {
      logger.error(`[${this.serverName}] Command error: ${error}`);
      const errorResponse: SubscriptionResponse = {
        id: request.id,
        type: "error",
        success: false,
        error: errorMessage(error),
        ...deviceSessionErrorFields(error),
      };
      this.sendJson(socket, errorResponse);
    }
  }

  /**
   * Handle a subscribe command.
   */
  private async handleSubscribe(
    socket: Socket,
    request: SubscriptionCommand & Record<string, unknown>,
  ): Promise<void> {
    this.authorizeSubscription(request);
    const subscriptionId = `${this.serverName.toLowerCase()}-${++this.subscriptionCounter}`;
    const filter = this.parseSubscriptionFilter(request);

    this.subscribers.set(subscriptionId, {
      socket,
      subscriptionId,
      lastActivity: this.timer.now(),
      filter,
      backfilling: false,
      drainPending: false,
    });
    this.connections.set(
      socket,
      this.connections.get(socket) ?? {
        lastActivity: this.timer.now(),
        drainPending: false,
      },
    );

    const response: SubscriptionResponse = {
      id: request.id,
      type: "subscription_response",
      success: true,
      subscriptionId,
    };
    this.sendJson(socket, response);

    logger.info(`[${this.serverName}] New subscriber ${subscriptionId}`);

    this.onSubscribed(subscriptionId, filter, socket);
  }

  /** Generic subscription mechanics have no admission policy; concrete data servers opt in. */
  protected authorizeSubscription(_request: SubscriptionCommand & Record<string, unknown>): void {}

  /**
   * Called after a new subscriber is added. Override to send backfill data.
   */
  protected onSubscribed(_subscriptionId: string, _filter: TFilter, _socket: Socket): void {
    // Default: no-op
  }

  /**
   * Handle an unsubscribe command.
   */
  private async handleUnsubscribe(socket: Socket, request: SubscriptionCommand): Promise<void> {
    const subscriber = request.subscriptionId
      ? this.findSubscriber(socket, request.subscriptionId)
      : undefined;
    if (subscriber) {
      this.removeSubscription(subscriber.subscriptionId);
      logger.info(`[${this.serverName}] Unsubscribed ${subscriber.subscriptionId}`);
    }

    const response: SubscriptionResponse = {
      id: request.id,
      type: "subscription_response",
      success: true,
    };
    this.sendJson(socket, response);
  }

  /**
   * Handle a pong command (keepalive response).
   */
  private handlePong(socket: Socket): void {
    const now = this.timer.now();
    const connection = this.connections.get(socket);
    if (connection) {
      connection.lastActivity = now;
    }
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.socket === socket) {
        subscriber.lastActivity = now;
        logger.debug(`[${this.serverName}] Received pong from ${subscriber.subscriptionId}`);
      }
    }
  }

  /**
   * Called when a connection closes. Removes every subscription on that connection.
   */
  protected onConnectionClose(socket: Socket): void {
    for (const subscriber of this.removeSubscribersForSocket(socket)) {
      logger.info(`[${this.serverName}] Subscriber ${subscriber.subscriptionId} disconnected`);
    }
  }

  /**
   * Called when a connection error occurs. Removes every subscription on that connection.
   */
  protected onConnectionError(socket: Socket, _error: Error): void {
    this.removeSubscribersForSocket(socket);
  }

  /**
   * Push data to all matching subscribers.
   */
  protected pushToSubscribers(data: TPushData): number {
    let sentCount = 0;
    const deadSockets = new Set<Socket>();

    for (const [subscriptionId, subscriber] of this.subscribers) {
      if (deadSockets.has(subscriber.socket)) {
        continue;
      }
      if (!this.matchesFilter(subscriber.filter, data)) {
        continue;
      }

      if (subscriber.socket.destroyed) {
        deadSockets.add(subscriber.socket);
        continue;
      }

      if (subscriber.backfilling) {
        if (this.queueDuringBackfill(subscriptionId, subscriber, data)) {
          sentCount++;
        }
        if (subscriber.socket.destroyed) {
          deadSockets.add(subscriber.socket);
        }
        continue;
      }

      try {
        const json = JSON.stringify(this.createPushMessage(data, subscriptionId)) + "\n";
        const result = subscriber.socket.write(json);
        if (!result) {
          // write()=false is not a death signal — wait for drain; truly dead peers get reaped by timeoutMs.
          this.armDrainListener(subscriber.socket);
        }
        // A successful write only proves our local send buffer accepted the bytes — not that the
        // peer is alive. Liveness is tracked via inbound pongs (and drain events, which prove the
        // peer is actually reading), so we deliberately do NOT refresh lastActivity here. Otherwise
        // a self-sustaining write loop (e.g. screenshot keepalives) would keep refreshing liveness
        // and mask a subscriber that has stopped responding to pings, preventing it from ever
        // timing out.
        sentCount++;
      } catch (error) {
        logger.warn(`[${this.serverName}] Failed to send to ${subscriptionId}: ${error}`);
        deadSockets.add(subscriber.socket);
        try {
          subscriber.socket.destroy();
        } catch (error) {
          // The failed peer is retired below even if its socket has already closed.
          logger.debug(`Push socket failed-peer cleanup failed: ${errorMessage(error)}`);
        }
      }
    }

    for (const socket of deadSockets) {
      this.removeSubscribersForSocket(socket);
    }

    return sentCount;
  }

  private queueDuringBackfill(
    subscriptionId: string,
    subscriber: Subscriber<TFilter>,
    data: TPushData,
  ): boolean {
    const state = this.getBackfillState(subscriptionId);
    const key = this.pushEventKey(data);
    if (key !== null && (state.seen.has(key) || state.pendingKeys.has(key))) {
      return false;
    }
    if (state.pending.length === MAX_BACKFILL_QUEUE) {
      logger.warn(`[${this.serverName}] Backfill queue overflow for ${subscriptionId}`);
      try {
        this.sendJson(subscriber.socket, {
          type: "error",
          success: false,
          code: "BACKFILL_QUEUE_OVERFLOW",
          subscriptionId,
          error: `Backfill live-event queue exceeded ${MAX_BACKFILL_QUEUE} events`,
        } satisfies SubscriptionResponse);
      } catch (error) {
        logger.warn(
          `[${this.serverName}] Failed to report backfill overflow: ${errorMessage(error)}`,
        );
      }
      this.removeSubscription(subscriptionId);
      if (this.getSubscribersForSocket(subscriber.socket).length === 0) {
        try {
          subscriber.socket.end();
        } catch (error) {
          logger.warn(
            `[${this.serverName}] Failed to close overflowing subscriber: ${errorMessage(error)}`,
          );
          subscriber.socket.destroy();
        }
      }
      return false;
    }
    state.pending.push(data);
    if (key !== null) {
      state.pendingKeys.add(key);
    }
    return true;
  }

  /** Override for events with a stable persisted identity shared by backfill and live delivery. */
  protected pushEventKey(_data: TPushData): string | null {
    return null;
  }

  protected startBackfill(subscriptionId: string): void {
    const subscriber = this.subscribers.get(subscriptionId);
    if (subscriber) {
      subscriber.backfilling = true;
      this.getBackfillState(subscriptionId);
    }
  }

  protected recordBackfillEvent(subscriptionId: string, data: TPushData): boolean {
    const key = this.pushEventKey(data);
    if (key === null) {
      return true;
    }
    const state = this.getBackfillState(subscriptionId);
    if (state.seen.has(key)) {
      return false;
    }
    state.seen.add(key);
    return true;
  }

  protected async finishBackfill(subscriptionId: string): Promise<void> {
    const state = this.backfills.get(subscriptionId);
    try {
      while (state?.pending.length) {
        const subscriber = this.subscribers.get(subscriptionId);
        if (!subscriber || subscriber.socket.destroyed) {
          return;
        }
        const data = state.pending.shift()!;
        const key = this.pushEventKey(data);
        if (key !== null) {
          state.pendingKeys.delete(key);
        }
        if (key !== null && state.seen.has(key)) {
          continue;
        }
        if (key !== null) {
          state.seen.add(key);
        }
        const ok = this.sendJson(subscriber.socket, this.createPushMessage(data, subscriptionId));
        if (!ok && !(await this.waitForDrain(subscriber.socket))) {
          return;
        }
      }
    } finally {
      this.backfills.delete(subscriptionId);
      const subscriber = this.subscribers.get(subscriptionId);
      if (subscriber) {
        subscriber.backfilling = false;
      }
    }
  }

  protected waitForDrain(socket: Socket): Promise<boolean> {
    if (socket.destroyed) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const cleanup = () => {
        socket.off("drain", onDrain);
        socket.off("close", onClose);
        socket.off("error", onError);
      };
      const onDrain = () => {
        cleanup();
        resolve(true);
      };
      const onClose = () => {
        cleanup();
        resolve(false);
      };
      const onError = () => {
        cleanup();
        resolve(false);
      };
      socket.once("drain", onDrain);
      socket.once("close", onClose);
      socket.once("error", onError);
      if (socket.destroyed) {
        onClose();
      }
    });
  }

  private getBackfillState(subscriptionId: string): BackfillState<TPushData> {
    let state = this.backfills.get(subscriptionId);
    if (!state) {
      state = { pending: [], pendingKeys: new Set(), seen: new Set() };
      this.backfills.set(subscriptionId, state);
    }
    return state;
  }

  private armDrainListener(socket: Socket): void {
    this.ensureConnectionStates();
    const connection = this.connections.get(socket);
    if (!connection || connection.drainPending) {
      return;
    }
    if (typeof socket.once !== "function") {
      return;
    }
    connection.drainPending = true;
    this.setDrainPending(socket, true);
    socket.once("drain", () => {
      const currentConnection = this.connections.get(socket);
      if (!currentConnection) {
        return;
      }
      const now = this.timer.now();
      currentConnection.drainPending = false;
      currentConnection.lastActivity = now;
      this.setDrainPending(socket, false);
      for (const subscriber of this.getSubscribersForSocket(socket)) {
        subscriber.lastActivity = now;
      }
    });
  }

  /** Finds a subscription owned by a connection without exposing other connections' subscriptions. */
  protected findSubscriber(
    socket: Socket,
    subscriptionId: string,
  ): Subscriber<TFilter> | undefined {
    const subscriber = this.subscribers.get(subscriptionId);
    return subscriber?.socket === socket ? subscriber : undefined;
  }

  /** Returns every active subscription held by a connection. */
  protected getSubscribersForSocket(socket: Socket): Subscriber<TFilter>[] {
    return [...this.subscribers.values()].filter((subscriber) => subscriber.socket === socket);
  }

  /** Removes every subscription held by a connection and returns the removed entries. */
  protected removeSubscribersForSocket(socket: Socket): Subscriber<TFilter>[] {
    const removed = this.getSubscribersForSocket(socket);
    for (const subscriber of removed) {
      this.subscribers.delete(subscriber.subscriptionId);
      this.backfills.delete(subscriber.subscriptionId);
    }
    this.connections.delete(socket);
    return removed;
  }

  private removeSubscription(subscriptionId: string): Subscriber<TFilter> | undefined {
    const subscriber = this.subscribers.get(subscriptionId);
    if (!subscriber) {
      return undefined;
    }
    this.subscribers.delete(subscriptionId);
    this.backfills.delete(subscriptionId);
    if (this.getSubscribersForSocket(subscriber.socket).length === 0) {
      this.connections.delete(subscriber.socket);
    }
    return subscriber;
  }

  private ensureConnectionStates(): void {
    for (const subscriber of this.subscribers.values()) {
      const connection = this.connections.get(subscriber.socket);
      if (!connection) {
        this.connections.set(subscriber.socket, {
          lastActivity: subscriber.lastActivity,
          drainPending: subscriber.drainPending,
        });
      } else if (subscriber.lastActivity > connection.lastActivity) {
        connection.lastActivity = subscriber.lastActivity;
      }
    }
  }

  private setDrainPending(socket: Socket, drainPending: boolean): void {
    for (const subscriber of this.getSubscribersForSocket(socket)) {
      subscriber.drainPending = drainPending;
    }
  }

  /**
   * Get the current subscriber count.
   */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Canonical validation for the `deviceSessionUuid` subscription key, shared by every
   * push socket server. JSON parsing does not validate fields at runtime, so a bare cast
   * lets a blank string or a non-string value become a filter that can never match an
   * event while `handleSubscribe` still acks `success: true` — an inert subscription the
   * client has no way to notice (#6676).
   *
   * Throws, so the `processLine` catch path answers with the standard
   * `{ type: "error", success: false, error }` envelope and no subscription is created.
   *
   * @param value Raw value as it arrived on the wire.
   * @returns The validated, whitespace-trimmed uuid, or null when the key is absent
   *          (an all-device subscription).
   */
  protected parseDeviceSessionUuid(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "string") {
      throw new Error("deviceSessionUuid must be a string or null");
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error("deviceSessionUuid must not be blank");
    }
    const restoreError = this.deviceSessionResolver?.getRestoreSupersededError(trimmed);
    if (restoreError) {
      throw restoreError;
    }
    // Return the trimmed key, never the raw one: filters compare by exact equality,
    // so a padded `" uuid-a "` would ack success and then match nothing - the same
    // inert subscription this validation exists to prevent (#6676).
    return trimmed;
  }

  /**
   * Parse subscription filter from request.
   * Subclasses must implement this.
   */
  protected abstract parseSubscriptionFilter(request: Record<string, unknown>): TFilter;

  /**
   * Check if data matches the subscriber's filter.
   * Subclasses must implement this.
   */
  protected abstract matchesFilter(filter: TFilter, data: TPushData): boolean;

  /**
   * Create a push message from data.
   * Subclasses must implement this.
   */
  protected abstract createPushMessage(data: TPushData, subscriptionId: string): unknown;
}
