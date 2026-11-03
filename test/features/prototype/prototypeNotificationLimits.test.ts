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

  test("the total size budget holds the largest title, body and data together", () => {
    expect(
      MAX_PROTOTYPE_NOTIFICATION_TITLE_LENGTH +
        MAX_PROTOTYPE_NOTIFICATION_BODY_LENGTH +
        MAX_PROTOTYPE_NOTIFICATION_DATA_BYTES,
    ).toBeLessThanOrEqual(MAX_PROTOTYPE_NOTIFICATION_BYTES);
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
