import { z } from "zod";
import { PROTOTYPE_NOTIFICATION_TAG_PREFIX } from "../systemTray/notificationDumpsys";

/**
 * The `notifications` module report (#14277): what the posting runtime itself has posted, so an agent
 * can assert a prototype notification without reading the shade.
 *
 * {@link prototypeNotificationsReport} is the reference the Android and iOS runtimes copy to build the
 * report from a platform snapshot: Android's `NotificationManager.getActiveNotifications()` (the
 * `proto:` posting tag) and iOS's `deliveredNotifications()` / `pendingNotificationRequests()` (the
 * `proto:` request identifier). Kotlin and Swift `PrototypeNotificationsReport` replay the shared
 * cases in `test/fixtures/prototype-notifications/report.json`.
 *
 * - Only records whose tag is `proto:<id>` are reported, as `id`; other notifications of the app are
 *   not the prototype's.
 * - A record without a string `channel` and `title` is dropped. An absent `body`, `group` or an
 *   unreadable `progress` is omitted; `ongoing` defaults to `false` and `actions` to `[]`.
 * - `channels` sort by id, `active` by `postedAt` then id, and `pending` by `fireAt` then id. Ids
 *   compare by code unit, so the twins agree on ASCII ids.
 */

const progressSchema = z.union([
  z.object({ value: z.number().min(0).max(1) }).strict(),
  z.object({ indeterminate: z.literal(true) }).strict(),
]);

export const prototypeNotificationsReportSchema = z
  .object({
    permission: z.string(),
    badge: z.number().int().min(0),
    channels: z.array(
      z.object({ id: z.string(), importance: z.string(), blocked: z.boolean() }).strict(),
    ),
    active: z.array(
      z
        .object({
          id: z.string().min(1),
          channel: z.string(),
          title: z.string(),
          body: z.string().optional(),
          group: z.string().optional(),
          ongoing: z.boolean(),
          progress: progressSchema.optional(),
          actions: z.array(z.string()),
          postedAt: z.number(),
        })
        .strict(),
    ),
    pending: z.array(z.object({ id: z.string().min(1), fireAt: z.number() }).strict()),
  })
  .strict()
  .describe(
    "The notifications the prototype runtime has posted (proto:-tagged) and scheduled, read from the device",
  );

export type PrototypeNotificationsReport = z.infer<typeof prototypeNotificationsReportSchema>;
type ActiveNotification = PrototypeNotificationsReport["active"][number];
type PendingNotification = PrototypeNotificationsReport["pending"][number];
type Channel = PrototypeNotificationsReport["channels"][number];

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

function entries(value: unknown): Fields[] {
  return Array.isArray(value)
    ? value.map(fields).filter((entry): entry is Fields => entry !== undefined)
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The prototype notification id a `proto:<id>` tag names, or undefined for any other tag. */
export function prototypeNotificationIdOfTag(tag: unknown): string | undefined {
  return typeof tag === "string" &&
    tag.startsWith(PROTOTYPE_NOTIFICATION_TAG_PREFIX) &&
    tag.length > PROTOTYPE_NOTIFICATION_TAG_PREFIX.length
    ? tag.slice(PROTOTYPE_NOTIFICATION_TAG_PREFIX.length)
    : undefined;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function progressOf(value: unknown): ActiveNotification["progress"] {
  const progress = fields(value);
  const fraction = finite(progress?.value);
  if (fraction !== undefined && fraction >= 0 && fraction <= 1) {
    return { value: fraction };
  }
  return progress?.indeterminate === true ? { indeterminate: true } : undefined;
}

function channelOf(entry: Fields): Channel | undefined {
  const id = text(entry.id);
  const importance = text(entry.importance);
  return id !== undefined && importance !== undefined
    ? { id, importance, blocked: entry.blocked === true }
    : undefined;
}

function activeOf(entry: Fields): ActiveNotification | undefined {
  const id = prototypeNotificationIdOfTag(entry.tag);
  const channel = text(entry.channel);
  const title = text(entry.title);
  const postedAt = finite(entry.postedAt);
  if (id === undefined || channel === undefined || title === undefined || postedAt === undefined) {
    return undefined;
  }
  const body = text(entry.body);
  const group = text(entry.group);
  const progress = progressOf(entry.progress);
  return {
    id,
    channel,
    title,
    ...(body !== undefined ? { body } : {}),
    ...(group !== undefined ? { group } : {}),
    ongoing: entry.ongoing === true,
    ...(progress !== undefined ? { progress } : {}),
    actions: Array.isArray(entry.actions)
      ? entry.actions.filter((action): action is string => typeof action === "string")
      : [],
    postedAt,
  };
}

function pendingOf(entry: Fields): PendingNotification | undefined {
  const id = prototypeNotificationIdOfTag(entry.tag);
  const fireAt = finite(entry.fireAt);
  return id !== undefined && fireAt !== undefined ? { id, fireAt } : undefined;
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/**
 * The `notifications` report for one platform snapshot `{permission, badge, channels, posted,
 * pending}`, where `posted` and `pending` entries carry the platform `tag` (Android posting tag, iOS
 * request identifier). Malformed input yields empty lists, `permission: "unavailable"` and badge 0.
 */
export function prototypeNotificationsReport(snapshot: unknown): PrototypeNotificationsReport {
  const input = fields(snapshot) ?? {};
  const badge = finite(input.badge);
  return {
    permission: text(input.permission) ?? "unavailable",
    badge: badge !== undefined && Number.isInteger(badge) && badge >= 0 ? badge : 0,
    channels: entries(input.channels)
      .map(channelOf)
      .filter(defined)
      .sort((left, right) => compareIds(left.id, right.id)),
    active: entries(input.posted)
      .map(activeOf)
      .filter(defined)
      .sort((left, right) => left.postedAt - right.postedAt || compareIds(left.id, right.id)),
    pending: entries(input.pending)
      .map(pendingOf)
      .filter(defined)
      .sort((left, right) => left.fireAt - right.fireAt || compareIds(left.id, right.id)),
  };
}
