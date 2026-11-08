import { describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  MAX_PROTOTYPE_NOTIFICATION_ACTIONS,
  MAX_PROTOTYPE_NOTIFICATION_BADGE,
  MAX_PROTOTYPE_NOTIFICATION_BODY_LENGTH,
  MAX_PROTOTYPE_NOTIFICATION_BYTES,
  MAX_PROTOTYPE_NOTIFICATION_CHANNELS,
  MAX_PROTOTYPE_NOTIFICATION_DATA_BYTES,
  MAX_PROTOTYPE_NOTIFICATION_ID_LENGTH,
  MAX_PROTOTYPE_NOTIFICATION_TITLE_LENGTH,
  MAX_PROTOTYPE_NOTIFICATIONS_ACTIVE,
} from "../../../src/features/prototype/prototypeNotificationLimits";
import { prototypeNotificationTotalError } from "../../../src/features/prototype/prototypeNotifications";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const notifications = contract.platformModules.notifications;
const post = notifications.calls.post.args;

function postSpec(args: Record<string, unknown>, channelCount = 1) {
  return {
    id: "notify-limits",
    window: { placement: { type: "fullscreen" } },
    requires: {
      platform: ["notifications"],
      permissions: [{ name: "notifications", purpose: "Tell you about new messages" }],
    },
    notifications: {
      channels: Array.from({ length: channelCount }, (_, index) => ({
        id: index === 0 ? "messages" : `channel${index}`,
        name: `Channel ${index}`,
        importance: "default",
      })),
    },
    root: {
      type: "button",
      label: "Notify",
      onTap: [
        {
          type: "platform",
          call: "notifications.post",
          args: {
            id: { value: "msg-1" },
            channel: { value: "messages" },
            title: { value: "Ada" },
            ...Object.fromEntries(Object.entries(args).map(([key, value]) => [key, { value }])),
          },
        },
      ],
    },
  };
}

function errorPath(spec: unknown): string | undefined {
  const result = validatePrototypeSpec(spec);
  return result.success ? undefined : result.error.path;
}

describe("notification contract limits (#14280)", () => {
  test("the contract rules repeat the named limits", () => {
    expect(contract.definitions.notificationsBlock.fields.channels.rule.max).toBe(
      MAX_PROTOTYPE_NOTIFICATION_CHANNELS,
    );
    expect(post.actions.value.max).toBe(MAX_PROTOTYPE_NOTIFICATION_ACTIONS);
    expect(post.id.value.max).toBe(MAX_PROTOTYPE_NOTIFICATION_ID_LENGTH);
    expect(post.title.value.max).toBe(MAX_PROTOTYPE_NOTIFICATION_TITLE_LENGTH);
    expect(post.body.value.max).toBe(MAX_PROTOTYPE_NOTIFICATION_BODY_LENGTH);
    expect(post.data.value.maxBytes).toBe(MAX_PROTOTYPE_NOTIFICATION_DATA_BYTES);
    expect(post.badge.value.max).toBe(MAX_PROTOTYPE_NOTIFICATION_BADGE);
    expect(notifications.calls.setBadge.args.count.value.max).toBe(
      MAX_PROTOTYPE_NOTIFICATION_BADGE,
    );
    expect(notifications.state.badge.value.max).toBe(MAX_PROTOTYPE_NOTIFICATION_BADGE);
    expect(notifications.state.active.value.max).toBe(MAX_PROTOTYPE_NOTIFICATIONS_ACTIVE);
  });

  test("the resolved notification total is 5 KiB (#16864)", () => {
    expect(MAX_PROTOTYPE_NOTIFICATION_BYTES).toBe(5120);
  });

  // Title and body limits count UTF-16 code units, while the total is UTF-8 bytes of the resolved
  // record. One code unit is at most 3 UTF-8 bytes, so every literal that passes the per-field
  // limits fits the total; text bound at post time is still measured on its own (#16864).
  const utf8 = (text: string) => new TextEncoder().encode(text).length;
  const dataBytes = MAX_PROTOTYPE_NOTIFICATION_DATA_BYTES;
  // `{"d":"…"}` is 8 bytes of JSON around the string.
  const dataOf = (bytes: number) => ({ d: "x".repeat(bytes - 8) });

  test("ASCII content at every per-field limit fits the total byte budget", () => {
    const title = "t".repeat(MAX_PROTOTYPE_NOTIFICATION_TITLE_LENGTH);
    const body = "b".repeat(MAX_PROTOTYPE_NOTIFICATION_BODY_LENGTH);
    expect(utf8(title) + utf8(body) + dataBytes).toBeLessThanOrEqual(
      MAX_PROTOTYPE_NOTIFICATION_BYTES,
    );
  });

  test("3-byte content at every per-field limit passes validation and fits the total", () => {
    const title = "\u4e2d".repeat(MAX_PROTOTYPE_NOTIFICATION_TITLE_LENGTH);
    const body = "\u4e2d".repeat(MAX_PROTOTYPE_NOTIFICATION_BODY_LENGTH);
    expect(errorPath(postSpec({ title, body, data: dataOf(dataBytes) }))).toBeUndefined();
    expect(utf8(title) + utf8(body) + dataBytes).toBe(4480);
    expect(
      prototypeNotificationTotalError({ title, body, data: dataOf(dataBytes) }),
    ).toBeUndefined();
  });

  test("an emoji-heavy notification of 5,632 bytes is still refused with invalid_args", () => {
    const emoji = "\u{1F600}";
    const title = emoji.repeat(MAX_PROTOTYPE_NOTIFICATION_TITLE_LENGTH);
    const body = emoji.repeat(MAX_PROTOTYPE_NOTIFICATION_BODY_LENGTH);
    expect(utf8(title) + utf8(body) + dataBytes).toBe(5632);
    expect(prototypeNotificationTotalError({ title, body, data: dataOf(dataBytes) })).toEqual({
      code: "invalid_args",
      path: "args",
      message: "The resolved notification is 5632 bytes; the limit is 5120 bytes",
    });
  });

  test("the total accepts its boundary and refuses one byte past it", () => {
    const title = "t".repeat(MAX_PROTOTYPE_NOTIFICATION_TITLE_LENGTH);
    const data = dataOf(dataBytes);
    // Only text bound at post time can reach the total; literals top out at 4,480 bytes.
    const body = "\u4e2d".repeat(1322) + "bb";
    expect(utf8(title) + utf8(body) + dataBytes).toBe(MAX_PROTOTYPE_NOTIFICATION_BYTES);
    expect(prototypeNotificationTotalError({ title, body, data })).toBeUndefined();
    expect(prototypeNotificationTotalError({ title, body: `${body}b`, data })?.code).toBe(
      "invalid_args",
    );
  });

  test("the total counts a notification without body or data", () => {
    expect(prototypeNotificationTotalError({ title: "Ada" })).toBeUndefined();
  });

  test("each string limit accepts its boundary and rejects one past it", () => {
    const cases = [
      ["id", MAX_PROTOTYPE_NOTIFICATION_ID_LENGTH],
      ["title", MAX_PROTOTYPE_NOTIFICATION_TITLE_LENGTH],
      ["body", MAX_PROTOTYPE_NOTIFICATION_BODY_LENGTH],
    ] as const;
    for (const [arg, max] of cases) {
      expect(errorPath(postSpec({ [arg]: "t".repeat(max) }))).toBeUndefined();
      expect(errorPath(postSpec({ [arg]: "t".repeat(max + 1) }))).toBe(
        `root.onTap[0].args.${arg}.value`,
      );
    }
  });

  test("the channel and action counts accept their boundary and reject one past it", () => {
    expect(errorPath(postSpec({}, MAX_PROTOTYPE_NOTIFICATION_CHANNELS))).toBeUndefined();
    expect(errorPath(postSpec({}, MAX_PROTOTYPE_NOTIFICATION_CHANNELS + 1))).toBe(
      "notifications.channels",
    );
    const actions = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `a${index}`, label: `A${index}` }));
    expect(
      errorPath(postSpec({ actions: actions(MAX_PROTOTYPE_NOTIFICATION_ACTIONS) })),
    ).toBeUndefined();
    expect(errorPath(postSpec({ actions: actions(MAX_PROTOTYPE_NOTIFICATION_ACTIONS + 1) }))).toBe(
      "root.onTap[0].args.actions.value",
    );
  });
});
