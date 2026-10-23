import type { ToolMutation } from "./deviceMutationAdapters";
import type { BootedDevice } from "../models";
import { isStandardIosStore } from "../features/preferences/preferenceValues";
import { opaqueIntentKey } from "../daemon/sessionBroker/mutations/types";
import { isRecord } from "./pipeline/isRecord";

export function dataToolMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: BootedDevice["platform"],
): ToolMutation[] | undefined {
  switch (name) {
    case "setKeyValue":
    case "removeKeyValue":
    case "clearKeyValueFile":
      return keyValueMutations(name, args, platform);
    case "deleteKeychainItem":
      return [
        {
          kind: "preference",
          key: JSON.stringify({ store: "keychain", appId: args.appId, selector: args.selector }),
        },
      ];
    case "setPreference":
      return preferenceMutations(args);
    case "sendBroadcast":
      return broadcastMutations(args, platform);
    case "backgroundWork":
      return backgroundWorkMutations(args, platform);
    default:
      return opaqueDataToolMutations(name, args);
  }
}

function keyValueMutations(
  name: string,
  args: Record<string, unknown>,
  platform?: BootedDevice["platform"],
): ToolMutation[] {
  const storeName = args.name ?? args.fileName;
  const standard =
    platform === "ios" &&
    typeof storeName === "string" &&
    typeof args.appId === "string" &&
    isStandardIosStore({ scope: "userDefaults", appId: args.appId, suite: storeName, key: "" });
  return [
    {
      kind: "preference",
      key: JSON.stringify({
        store: "key-value",
        appId: args.appId,
        name: standard ? "standard" : storeName,
        userId: args.userId ?? null,
        key: name === "clearKeyValueFile" ? null : args.key,
      }),
    },
  ];
}

function preferenceMutations(args: Record<string, unknown>): ToolMutation[] {
  const standard =
    args.scope === "userDefaults" &&
    (args.suite === undefined || typeof args.suite === "string") &&
    isStandardIosStore({
      scope: "userDefaults",
      appId: typeof args.appId === "string" ? args.appId : undefined,
      suite: typeof args.suite === "string" ? args.suite : undefined,
      key: "",
    });
  return [
    {
      kind: "preference",
      key: JSON.stringify({
        store: "preference",
        scope: args.scope,
        appId: args.appId ?? null,
        suite: standard ? null : (args.suite ?? null),
        userId: args.userId ?? null,
        key: args.key,
      }),
    },
  ];
}

function opaqueDataToolMutations(
  name: string,
  args: Record<string, unknown>,
): ToolMutation[] | undefined {
  switch (name) {
    case "sqlQuery":
      return [{ kind: "opaque", key: opaqueIntentKey("sql", args.appId, args.databasePath) }];
    case "mockNetwork":
    case "clearMockNetwork":
      return [{ kind: "opaque", key: "network-mocks" }];
    case "phoneCall":
    case "sendSms":
      return [{ kind: "opaque", key: opaqueIntentKey(name) }];
    case "resetAppLogs":
      return Array.isArray(args.paths)
        ? args.paths.map((path) => ({
            kind: "opaque",
            key: opaqueIntentKey(
              "resetAppLogs",
              "app-logs",
              args.appId,
              args.container ?? "documents",
              path,
            ),
          }))
        : [];
    case "deviceSnapshot":
      return [
        {
          kind: "opaque",
          key: JSON.stringify(["snapshot", args.action, args.snapshotName ?? null]),
        },
      ];
    default:
      return undefined;
  }
}

/**
 * `am broadcast` into the app under test runs arbitrary receiver code (seed data, toggled debug
 * flags, writes to app storage) that no revert or baseline clean can undo, so every broadcast
 * is a `fallback:` opaque intent. `waitForResult` only changes how the result is reported: the
 * broadcast is sent either way. A broadcast `am` later refuses (protected action, receiver not
 * declared, package missing) still records, because that is only known after it is sent. iOS has
 * no broadcast intents and the handler returns before touching the device.
 */
function broadcastMutations(
  args: Record<string, unknown>,
  platform?: BootedDevice["platform"],
): ToolMutation[] {
  if (platform === "ios") {
    return [];
  }
  const intent = isRecord(args.intent) ? args.intent : {};
  return [
    {
      kind: "opaque",
      key: opaqueIntentKey(
        "sendBroadcast",
        args.appId,
        args.userId ?? null,
        intent.action,
        intent.component ?? null,
      ),
    },
  ];
}

/**
 * `list` and `listAlarms` only run dumpsys and logcat reads. `runJob` starts the app's own job
 * (`cmd jobscheduler run`), whose work the tool itself documents as not undoable, so it is a
 * `fallback:` opaque intent per job target. `workManagerDiagnostics` broadcasts WorkManager's
 * library-owned diagnostics action: it enqueues a one-time logging worker and changes no app
 * data, so it leaves a breadcrumb that does not force the fallback reset.
 */
function backgroundWorkMutations(
  args: Record<string, unknown>,
  platform?: BootedDevice["platform"],
): ToolMutation[] {
  const { action } = args;
  if (platform === "ios" || action === "list" || !isRecord(action) || "listAlarms" in action) {
    return [];
  }
  if (isRecord(action.runJob)) {
    const { jobId, worker } = action.runJob;
    return [
      {
        kind: "opaque",
        key: opaqueIntentKey(
          "backgroundWork",
          "runJob",
          args.appId,
          args.userId ?? null,
          jobId ?? null,
          worker ?? null,
        ),
      },
    ];
  }
  return "workManagerDiagnostics" in action
    ? [
        {
          kind: "opaque",
          key: JSON.stringify(["backgroundWork", "workManagerDiagnostics", args.appId]),
        },
      ]
    : [];
}
