import type { ToolMutation } from "./deviceMutationAdapters";
import type { BootedDevice } from "../models";
import { isStandardIosStore } from "../features/preferences/preferenceValues";

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
    case "setPreference":
      return preferenceMutations(args);
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
      return [{ kind: "opaque", key: JSON.stringify(["sql", args.appId, args.databasePath]) }];
    case "mockNetwork":
    case "clearMockNetwork":
      return [{ kind: "opaque", key: "network-mocks" }];
    case "phoneCall":
    case "sendSms":
      return [{ kind: "opaque", key: `tool:${name}` }];
    case "resetAppLogs":
      return Array.isArray(args.paths)
        ? args.paths.map((path) => ({
            kind: "opaque",
            key: JSON.stringify(["app-logs", args.appId, args.container ?? "documents", path]),
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
