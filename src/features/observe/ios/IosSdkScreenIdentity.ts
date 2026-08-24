import type { ScreenIdentity } from "../../../models";

type StringMap = Record<string, string>;

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function stringMap(value: unknown): StringMap {
  return value && typeof value === "object" ? (value as StringMap) : {};
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    const string = stringValue(value);
    if (string) {
      return string;
    }
  }
  return undefined;
}

function selectedTab(
  arguments_: StringMap,
  metadata: StringMap,
  route: string,
): string | undefined {
  return firstNonEmpty(
    arguments_.tab,
    metadata.tab,
    metadata.type === "tab_switch" ? route : undefined,
  );
}

function presentation(metadata: StringMap): string | undefined {
  return firstNonEmpty(metadata.presentation, metadata.modal, metadata.sheet);
}

function makeKey(
  bundleId: string,
  route: string,
  arguments_: StringMap,
  tab?: string,
  presentationRoute?: string,
): string {
  const parts: string[][] = [
    ["bundle", bundleId],
    ["route", route],
  ];
  if (tab) {
    parts.push(["tab", tab]);
  }
  if (presentationRoute) {
    parts.push(["presentation", presentationRoute]);
  }
  for (const [name, value] of Object.entries(arguments_)
    .map(([name, value]) => [stringValue(name), stringValue(value)] as const)
    .filter(
      (entry): entry is readonly [string, string] =>
        entry[0] !== undefined && entry[1] !== undefined && entry[0] !== "tab",
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    parts.push(["argument", name, value]);
  }
  return JSON.stringify(parts);
}

/**
 * Build a high-confidence screen identity from an iOS SDK navigation event.
 * The caller owns event ordering and stores the newest result per bundle.
 */
export function deriveIosSdkScreenIdentity(
  eventType: string,
  applicationId: string | null | undefined,
  payload: Record<string, unknown>,
): ScreenIdentity | undefined {
  if (eventType !== "navigation") {
    return undefined;
  }
  const route = stringValue(payload.destination);
  if (!applicationId || !route) {
    return undefined;
  }

  const arguments_ = stringMap(payload.arguments);
  const tab = selectedTab(arguments_, stringMap(payload.metadata), route);
  const presentationRoute = presentation(stringMap(payload.metadata));
  return {
    platform: "ios",
    source: "sdk",
    confidence: "high",
    key: makeKey(applicationId, route, arguments_, tab, presentationRoute),
    components: {
      bundleId: applicationId,
      navigationRoute: route,
      ...(tab ? { selectedTab: tab } : {}),
      ...(presentationRoute ? { presentation: presentationRoute } : {}),
    },
  };
}
