import type { Socket } from "node:net";
import { logger } from "../utils/logger";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { PushSubscriptionSocketServer, getSocketPath } from "./socketServer/index";
import type { TelemetryEvent } from "../features/telemetry/TelemetryRecorder";
import { getNetworkEvents } from "../db/networkEventRepository";
import { getLogEvents } from "../db/logEventRepository";
import { getOsEvents } from "../db/osEventRepository";
import { getNavigationEvents } from "../db/navigationEventRepository";
import { getStorageEvents } from "../db/storageEventRepository";
import { getLayoutEvents } from "../db/layoutEventRepository";
import { getDatabase } from "../db/database";
import type { Database } from "../db/types";
import type { Kysely } from "kysely";
import { TELEMETRY_PUSH_SOCKET_CONFIG } from "./daemonFiles";
import { truncateBodyText, boundStructuredField } from "../utils/truncateBodyText";
import { buildNavigationNodeScreenshotUri } from "../utils/navigationResourceUri";
import { type DeviceSessionResolver, nullDeviceSessionResolver } from "./deviceSessionResolver";

/**
 * Opaque plain-text fields that the backfill fans out (limit=100) and that can
 * balloon a single subscribe by megabytes the dashboard already caps at 10KB
 * (#2801). Network bodies are already capped upstream in the repository
 * `mapRow`; this bounds the remaining plain-text columns at the backfill
 * boundary so the DB read contract for those repos is unchanged. Only opaque
 * text is listed here; structured-JSON columns that would be corrupted by a
 * blind slice are bounded separately via BOUNDED_BACKFILL_STRUCTURED_FIELDS
 * (#3182).
 */
const BOUNDED_BACKFILL_TEXT_FIELDS: Record<string, readonly string[]> = {
  log: ["message"],
  storage: ["value", "previousValue"],
};

/**
 * Structured-JSON fields the backfill fans out (limit=100) that can also
 * balloon a single subscribe. Slicing these mid-value would emit invalid JSON
 * (#3182), so they are bounded by total serialized size and replaced wholesale
 * with a small `{ _truncated, bytes }` marker when over budget — the result
 * stays valid JSON. `isJsonString` marks fields that arrive already serialized
 * (layout `detailsJson`) versus parsed objects/arrays (os `details`; failure
 * `stackTrace` is bounded at its push site since it is composed there).
 */
const BOUNDED_BACKFILL_STRUCTURED_FIELDS: Record<
  string,
  readonly { field: string; isJsonString: boolean }[]
> = {
  os: [{ field: "details", isJsonString: false }],
  layout: [{ field: "detailsJson", isJsonString: true }],
};

/**
 * Cap known large fields on a backfilled telemetry event, returning a shallow
 * copy when anything changed so the caller's source rows are not mutated. Plain
 * text is capped to BODY_TRUNCATION_LIMIT (surrogate-safe, see truncateBodyText);
 * structured-JSON fields are bounded by serialized size and replaced with a
 * valid-JSON truncation marker when over budget (see boundStructuredField).
 */
export function boundBackfillEventText(event: TelemetryEvent): TelemetryEvent {
  const textFields = BOUNDED_BACKFILL_TEXT_FIELDS[event.category];
  const structuredFields = BOUNDED_BACKFILL_STRUCTURED_FIELDS[event.category];
  if ((!textFields && !structuredFields) || event.data === null || typeof event.data !== "object") {
    return event;
  }
  const data = event.data as Record<string, unknown>;
  let bounded: Record<string, unknown> | null = null;
  for (const field of textFields ?? []) {
    const value = data[field];
    if (typeof value !== "string") {
      continue;
    }
    const capped = truncateBodyText(value);
    if (capped !== value) {
      bounded = bounded ?? { ...data };
      bounded[field] = capped;
    }
  }
  for (const { field, isJsonString } of structuredFields ?? []) {
    const value = data[field];
    const capped = boundStructuredField(value, isJsonString);
    if (capped !== value) {
      bounded = bounded ?? { ...data };
      bounded[field] = capped;
    }
  }
  return bounded ? { ...event, data: bounded as TelemetryEvent["data"] } : event;
}

interface TelemetryFilter {
  category: string | null; // "network", "log", "os", "navigation", "crash", "anr", "nonfatal", "storage", "layout", or null for all
  /**
   * Primary device routing key (epic #5256). `null` matches every device.
   * Live-event delivery filters on this.
   */
  deviceSessionUuid: string | null;
  /**
   * Serial/UDID resolved from `deviceSessionUuid` at subscribe time. Retained
   * only for the serial-scoped backfill DB queries (which key on the persisted
   * `device_id`); it is NOT the live routing key. `null` for an all-devices
   * subscription or a `deviceSessionUuid` with no live epoch.
   */
  deviceId: string | null;
  sessionId: string | null;
}

interface TelemetryPushMessage {
  type: "telemetry_push";
  timestamp: number;
  data: TelemetryEvent;
  subscriptionId: string;
}

export class TelemetryPushSocketServer extends PushSubscriptionSocketServer<
  TelemetryFilter,
  TelemetryEvent
> {
  private deviceSessionResolver: DeviceSessionResolver = nullDeviceSessionResolver;

  constructor(
    socketPath: string = getSocketPath(TELEMETRY_PUSH_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
  ) {
    super(socketPath, timer, "TelemetryPush");
  }

  /** Wire the serial↔`deviceSessionUuid` resolver used to stamp and route events. */
  setDeviceSessionResolver(resolver: DeviceSessionResolver): void {
    this.deviceSessionResolver = resolver;
  }

  /** Stamp the live `deviceSessionUuid` for an event's serial (epic #5256). */
  private stampDeviceSession(event: TelemetryEvent): TelemetryEvent {
    const deviceSessionUuid = event.deviceId
      ? this.deviceSessionResolver.resolveUuid(event.deviceId)
      : null;
    return { ...event, deviceSessionUuid };
  }

  pushTelemetryEvent(event: TelemetryEvent): void {
    const stamped = this.stampDeviceSession(event);
    const sentCount = this.pushToSubscribers(stamped);
    if (sentCount > 0) {
      logger.info(`[TelemetryPush] Pushed ${stamped.category} event to ${sentCount} subscribers`);
    } else if (stamped.category === "navigation") {
      logger.warn(
        `[TelemetryPush] No subscribers matched navigation event (${this.getSubscriberCount()} total subs, event deviceId: ${stamped.deviceId})`,
      );
    }
  }

  protected parseSubscriptionFilter(request: Record<string, unknown>): TelemetryFilter {
    const deviceSessionUuid = (request.deviceSessionUuid as string) ?? null;
    return {
      category: (request.category as string) ?? null,
      deviceSessionUuid,
      // Resolve the serial once, at subscribe time, for the serial-scoped backfill
      // queries. Within an epoch the serial is stable, so a snapshot is safe.
      deviceId: deviceSessionUuid
        ? this.deviceSessionResolver.resolveDeviceId(deviceSessionUuid)
        : null,
      sessionId: (request.sessionId as string) ?? null,
    };
  }

  protected matchesFilter(filter: TelemetryFilter, data: TelemetryEvent): boolean {
    if (filter.category !== null && filter.category !== data.category) {
      return false;
    }
    if (filter.sessionId !== null && filter.sessionId !== data.sessionId) {
      return false;
    }
    if (
      filter.deviceSessionUuid !== null &&
      filter.deviceSessionUuid !== (data.deviceSessionUuid ?? null)
    ) {
      return false;
    }
    return true;
  }

  protected override onSubscribed(
    subscriptionId: string,
    filter: TelemetryFilter,
    socket: Socket,
  ): void {
    const subscriber = this.subscribers.get(subscriptionId);
    if (subscriber) {
      subscriber.backfilling = true;
    }
    this.backfillRecentEvents(subscriptionId, filter, socket)
      .catch((err) => logger.warn(`[TelemetryPush] Backfill failed: ${err}`))
      .finally(() => {
        const sub = this.subscribers.get(subscriptionId);
        if (sub) {
          sub.backfilling = false;
        }
      });
  }

  private async backfillRecentEvents(
    subscriptionId: string,
    filter: TelemetryFilter,
    socket: Socket,
  ): Promise<void> {
    const limit = 100;
    // A subscription that named a specific deviceSessionUuid which no longer
    // resolves to a live serial (retired epoch) must backfill NOTHING — never fall
    // through to an all-devices query, which would leak other devices' history to a
    // stale-uuid subscriber (epic #5256, AC4). An all-devices subscription
    // (deviceSessionUuid === null) still backfills every device.
    if (filter.deviceSessionUuid !== null && filter.deviceId === null) {
      return;
    }
    const deviceId = filter.deviceId ?? undefined;
    const sessionId = filter.sessionId ?? undefined;
    const events: TelemetryEvent[] = [];

    const shouldInclude = (category: string) =>
      filter.category === null || filter.category === category;

    // Run independent backfill queries in parallel
    const [networkRows, logRows, osRows] = await Promise.all([
      shouldInclude("network") ? getNetworkEvents({ deviceId, sessionId, limit }) : [],
      shouldInclude("log") ? getLogEvents({ deviceId, sessionId, limit }) : [],
      shouldInclude("os") ? getOsEvents({ deviceId, sessionId, limit }) : [],
    ]);
    for (const r of networkRows) {
      events.push({
        category: "network",
        timestamp: r.timestamp,
        deviceId: r.deviceId,
        sessionId: r.sessionId ?? null,
        data: r,
      });
    }
    for (const r of logRows) {
      events.push({
        category: "log",
        timestamp: r.timestamp,
        deviceId: r.deviceId,
        sessionId: r.sessionId ?? null,
        data: r,
      });
    }
    for (const r of osRows) {
      events.push({
        category: "os",
        timestamp: r.timestamp,
        deviceId: r.deviceId,
        sessionId: r.sessionId ?? null,
        data: r,
      });
    }

    if (shouldInclude("navigation")) {
      const rows = await getNavigationEvents({ deviceId, sessionId, limit });
      // Look up screenshot node IDs for navigation events
      const screenshotUris: Map<string, string> = new Map();
      if (rows.length > 0) {
        try {
          const db = getDatabase() as unknown as Kysely<Database>;
          const destinations = [...new Set(rows.map((r) => r.destination))];
          const nodes = await db
            .selectFrom("navigation_nodes")
            .select(["id", "screen_name", "app_id"])
            .where("screen_name", "in", destinations)
            .execute();
          for (const node of nodes) {
            const key = `${node.app_id}:${node.screen_name}`;
            // Scope by the node's app_id (already selected) so a telemetry client
            // following this URI resolves the screenshot under the named app, not
            // the daemon's current foreground app (#5851 / #5534).
            screenshotUris.set(key, buildNavigationNodeScreenshotUri(node.id, node.app_id));
          }
        } catch {
          /* best-effort screenshot URI lookup */
        }
      }
      for (const r of rows) {
        const screenshotUri = screenshotUris.get(`${r.applicationId}:${r.destination}`) ?? null;
        events.push({
          category: "navigation",
          timestamp: r.timestamp,
          deviceId: r.deviceId,
          sessionId: r.sessionId ?? null,
          data: { ...r, screenshotUri },
        });
      }
    }

    // Backfill failures (crash/anr/nonfatal) in parallel
    const failureTypes = ["crash", "anr", "nonfatal"] as const;
    const failureBackfillFn = async (failureType: (typeof failureTypes)[number]) => {
      if (!shouldInclude(failureType)) {
        return;
      }
      try {
        const db = getDatabase() as unknown as Kysely<Database>;
        let q = db
          .selectFrom("failure_occurrences")
          .innerJoin("failure_groups", "failure_groups.id", "failure_occurrences.group_id")
          .select([
            "failure_occurrences.id as occurrenceId",
            "failure_occurrences.group_id as groupId",
            "failure_occurrences.timestamp",
            "failure_occurrences.device_id as deviceId",
            // Selected so the crash/ANR/tool-failure backfill can report the
            // originating session like every sibling projection does (#4209).
            // Without it `r.sessionId` is a type error AND always undefined at
            // runtime, so these events shipped with `sessionId: null` and were
            // invisible to session-filtered subscribers.
            "failure_occurrences.session_id as sessionId",
            "failure_occurrences.screen_at_failure as screen",
            "failure_groups.type",
            "failure_groups.severity",
            "failure_groups.title",
            "failure_groups.stack_trace_json",
          ])
          .where("failure_groups.type", "=", failureType);

        // Always filter by device — never send failures with empty/null device_id
        if (deviceId) {
          q = q.where("failure_occurrences.device_id", "=", deviceId);
        } else {
          // Even without a device filter, exclude failures with no device_id
          q = q
            .where("failure_occurrences.device_id", "is not", null)
            .where("failure_occurrences.device_id", "!=", "");
        }
        if (sessionId) {
          q = q.where("failure_occurrences.session_id", "=", sessionId);
        }

        const rows = await q
          .orderBy("failure_occurrences.timestamp", "desc")
          .limit(limit)
          .execute();

        for (const r of rows) {
          let exceptionType: string | undefined;
          let stackTrace: unknown[] | null = null;
          if (r.stack_trace_json) {
            try {
              const frames = JSON.parse(r.stack_trace_json);
              if (Array.isArray(frames)) {
                stackTrace = frames;
                if (frames.length > 0) {
                  exceptionType = frames[0].className ?? frames[0].declaringClass;
                }
              }
            } catch {
              /* ignore parse errors */
            }
          }

          // Bound the parsed stack trace by serialized size so a multi-hundred-KB
          // frame array does not ship raw ×100 (#3182). exceptionType is read
          // above before bounding, so the marker never loses that summary.
          const boundedStackTrace = boundStructuredField(stackTrace, false);

          events.push({
            category: failureType,
            timestamp: r.timestamp,
            deviceId: r.deviceId,
            sessionId: r.sessionId ?? null,
            data: {
              type: r.type,
              occurrenceId: r.occurrenceId,
              groupId: r.groupId,
              severity: r.severity,
              title: r.title,
              exceptionType,
              screen: r.screen,
              timestamp: r.timestamp,
              stackTrace: boundedStackTrace,
            },
          });
        }
      } catch (e) {
        logger.warn(`[TelemetryPush] Failed to backfill ${failureType} events: ${e}`);
      }
    };
    await Promise.all(failureTypes.map(failureBackfillFn));

    const [storageRows, layoutRows] = await Promise.all([
      shouldInclude("storage") ? getStorageEvents({ deviceId, sessionId, limit }) : [],
      shouldInclude("layout") ? getLayoutEvents({ deviceId, sessionId, limit }) : [],
    ]);
    for (const r of storageRows) {
      events.push({
        category: "storage",
        timestamp: r.timestamp,
        deviceId: r.deviceId,
        sessionId: r.sessionId ?? null,
        data: r,
      });
    }
    for (const r of layoutRows) {
      events.push({
        category: "layout",
        timestamp: r.timestamp,
        deviceId: r.deviceId,
        sessionId: r.sessionId ?? null,
        data: r,
      });
    }

    // Sort oldest-first so dashboard shows them in correct order
    events.sort((a, b) => a.timestamp - b.timestamp);

    for (const event of events) {
      const subscriber = this.subscribers.get(subscriptionId);
      if (!subscriber || subscriber.socket !== socket) {
        return;
      }
      if (filter.sessionId !== null && event.sessionId !== filter.sessionId) {
        continue;
      }
      // Single boundary cap for large plain-text fields (#2801): network bodies
      // are already capped in the repository mapRow; this bounds log/storage.
      // Stamp the device-session key so every backfilled frame carries the same
      // attribution as live frames (epic #5256, AC1).
      const msg = this.createPushMessage(
        this.stampDeviceSession(boundBackfillEventText(event)),
        subscriptionId,
      );
      this.sendJson(socket, msg);
    }

    logger.info(`[TelemetryPush] Backfilled ${events.length} events to new subscriber`);
  }

  protected createPushMessage(data: TelemetryEvent, subscriptionId: string): TelemetryPushMessage {
    return {
      type: "telemetry_push",
      timestamp: this.timer.now(),
      data,
      subscriptionId,
    };
  }
}

// Singleton instance
let socketServer: TelemetryPushSocketServer | null = null;

export function getTelemetryPushServer(): TelemetryPushSocketServer | null {
  return socketServer;
}

export function getTelemetryPushSocketPath(): string {
  return socketServer?.getSocketPath() ?? getSocketPath(TELEMETRY_PUSH_SOCKET_CONFIG);
}

export async function startTelemetryPushSocketServer(): Promise<TelemetryPushSocketServer> {
  if (!socketServer) {
    socketServer = new TelemetryPushSocketServer();
  }
  if (!socketServer.isListening()) {
    await socketServer.start();
  }
  return socketServer;
}

export async function stopTelemetryPushSocketServer(): Promise<void> {
  if (!socketServer) {
    return;
  }
  await socketServer.close();
  socketServer = null;
}
