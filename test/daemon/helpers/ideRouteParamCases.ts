import { spyOn } from "bun:test";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createTestUnixSocketServer } from "../../helpers/createTestUnixSocketServer";
import type { DaemonRequest } from "../../../src/daemon/types";
import { createFakeDaemonState } from "./inputSocketHarness";

/**
 * Param matrices for the `ide/*` routes that validate their own params (#11813), and a harness
 * that runs a case up to the first step after the param check. The goldens in
 * `test/fixtures/ide-route-params/golden.json` were captured from the hand-written checks.
 *
 * Every step past the check is replaced by a recorder that throws a sentinel carrying what the
 * check let through, so a valid case ends in `PAST_CHECK {...}` and an invalid one in the route's
 * refusal text. Nothing touches a device, listener or timer.
 */

export interface IdeParamCase {
  route: string;
  label: string;
  params: unknown;
}

const OBJECT_ONLY: ReadonlyArray<[string, unknown]> = [
  ["array", []],
  ["string", "x"],
  ["number", 3],
];
const NULLISH: ReadonlyArray<[string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
];

function badValues(route: string, base: Record<string, unknown>, key: string, values: unknown[]) {
  return values.map((value) => ({
    route,
    label: `${key} ${JSON.stringify(value) ?? "undefined"}`,
    params: { ...base, [key]: value },
  }));
}

export function ideRouteParamCases(): IdeParamCase[] {
  const cases: IdeParamCase[] = [];
  const falsy = [undefined, "", 0, null, false];

  const flag = { key: "debug", enabled: true };
  cases.push({ route: "ide/setFeatureFlag", label: "valid", params: flag });
  cases.push({
    route: "ide/setFeatureFlag",
    label: "valid false",
    params: { ...flag, enabled: false, config: { a: 1 } },
  });
  cases.push({
    route: "ide/setFeatureFlag",
    label: "config null",
    params: { ...flag, config: null },
  });
  cases.push(...badValues("ide/setFeatureFlag", flag, "key", falsy));
  cases.push({
    route: "ide/setFeatureFlag",
    label: "key number passes",
    params: { ...flag, key: 5 },
  });
  cases.push(...badValues("ide/setFeatureFlag", flag, "enabled", [undefined, "true", 1, null, 0]));
  for (const [label, params] of OBJECT_ONLY) {
    cases.push({ route: "ide/setFeatureFlag", label: `params ${label}`, params });
  }
  cases.push({ route: "ide/setFeatureFlag", label: "empty object", params: {} });

  const tool = { sessionUuid: "s1", toolName: "tapOn", enabled: true };
  cases.push({ route: "ide/setSessionToolEnabled", label: "valid", params: tool });
  cases.push({
    route: "ide/setSessionToolEnabled",
    label: "valid disabled",
    params: { ...tool, enabled: false },
  });
  cases.push(...badValues("ide/setSessionToolEnabled", tool, "sessionUuid", falsy));
  cases.push(
    ...badValues("ide/setSessionToolEnabled", tool, "toolName", [
      ...falsy,
      "nope",
      "observe",
      "setToolEnabled",
    ]),
  );
  cases.push(
    ...badValues("ide/setSessionToolEnabled", tool, "enabled", [undefined, "true", 1, null]),
  );
  for (const [label, params] of OBJECT_ONLY) {
    cases.push({ route: "ide/setSessionToolEnabled", label: `params ${label}`, params });
  }
  cases.push({ route: "ide/setSessionToolEnabled", label: "empty object", params: {} });

  const update = { deviceId: "emulator-5554", platform: "android" };
  cases.push({ route: "ide/updateService", label: "valid android", params: update });
  cases.push({
    route: "ide/updateService",
    label: "valid ios force",
    params: { deviceId: "u", platform: "ios", force: true },
  });
  cases.push(...badValues("ide/updateService", update, "deviceId", falsy));
  cases.push(...badValues("ide/updateService", update, "platform", [...falsy, "web", "iOS", 5]));
  cases.push({
    route: "ide/updateService",
    label: "platform checked after presence",
    params: { platform: "web" },
  });
  for (const [label, params] of OBJECT_ONLY) {
    cases.push({ route: "ide/updateService", label: `params ${label}`, params });
  }
  cases.push({ route: "ide/updateService", label: "empty object", params: {} });

  const setKv = { deviceId: "d", appId: "a", fileName: "f", key: "k", type: "string", value: "v" };
  cases.push({ route: "ide/setKeyValue", label: "valid", params: setKv });
  cases.push({
    route: "ide/setKeyValue",
    label: "valid null value",
    params: { ...setKv, value: null },
  });
  cases.push({
    route: "ide/setKeyValue",
    label: "valid platform",
    params: { ...setKv, platform: "ios" },
  });
  for (const key of ["deviceId", "appId", "fileName", "key", "type"]) {
    cases.push(...badValues("ide/setKeyValue", setKv, key, falsy));
  }
  cases.push({
    route: "ide/setKeyValue",
    label: "deviceId number passes",
    params: { ...setKv, deviceId: 5 },
  });
  for (const [label, params] of OBJECT_ONLY) {
    cases.push({ route: "ide/setKeyValue", label: `params ${label}`, params });
  }
  cases.push({ route: "ide/setKeyValue", label: "empty object", params: {} });

  const removeKv = { deviceId: "d", appId: "a", fileName: "f", key: "k" };
  cases.push({ route: "ide/removeKeyValue", label: "valid", params: removeKv });
  cases.push({
    route: "ide/removeKeyValue",
    label: "valid platform",
    params: { ...removeKv, platform: "android" },
  });
  for (const key of ["deviceId", "appId", "fileName", "key"]) {
    cases.push(...badValues("ide/removeKeyValue", removeKv, key, falsy));
  }
  for (const [label, params] of OBJECT_ONLY) {
    cases.push({ route: "ide/removeKeyValue", label: `params ${label}`, params });
  }
  cases.push({ route: "ide/removeKeyValue", label: "empty object", params: {} });

  const clearKv = { deviceId: "d", appId: "a", fileName: "f" };
  cases.push({ route: "ide/clearKeyValueFile", label: "valid", params: clearKv });
  cases.push({
    route: "ide/clearKeyValueFile",
    label: "valid platform",
    params: { ...clearKv, platform: "ios" },
  });
  for (const key of ["deviceId", "appId", "fileName"]) {
    cases.push(...badValues("ide/clearKeyValueFile", clearKv, key, falsy));
  }
  for (const [label, params] of OBJECT_ONLY) {
    cases.push({ route: "ide/clearKeyValueFile", label: `params ${label}`, params });
  }
  cases.push({ route: "ide/clearKeyValueFile", label: "empty object", params: {} });

  // Nullish params: the hand-written code read `.key` of undefined, an engine TypeError.
  for (const route of [
    "ide/setFeatureFlag",
    "ide/setSessionToolEnabled",
    "ide/updateService",
    "ide/setKeyValue",
    "ide/removeKeyValue",
    "ide/clearKeyValueFile",
  ]) {
    for (const [label, params] of NULLISH) {
      cases.push({ route, label: `params ${label}`, params });
    }
  }
  return cases;
}

/** Runs a case to the first step after the param check and reports what happened there. */
export async function runIdeParamCase(testCase: IdeParamCase): Promise<string> {
  const server = createTestUnixSocketServer(
    "/fake/ide-params.sock",
    "http://localhost:0/mcp",
    createFakeDaemonState(),
    new FakeTimer(),
  );
  const past = (...seen: unknown[]): never => {
    throw new Error(`PAST_CHECK ${JSON.stringify(seen)}`);
  };
  server["requireFeatureFlagService"] = () => ({}) as never;
  server["assertBrokerConnectionHostMutation"] = (_session, action) => past(action);
  server["assertBrokerConnectionControl"] = (_session, action, options) => past(action, options);
  server["resolveIdeActionDevices"] = (async (platform: unknown, deviceId: unknown) =>
    past(platform, deviceId)) as never;
  server["assertSocketToolEnabled"] = async (deviceId, toolName) => past(deviceId, toolName);
  // The unit-test registry is empty; one tool name stands in for "user configurable".
  const configurable = spyOn(ToolRegistry, "isUserConfigurableTool").mockImplementation(
    (name: string) => name === "tapOn",
  );
  const request: DaemonRequest = {
    id: "1",
    type: "mcp_request",
    method: testCase.route,
    params: testCase.params,
  };
  try {
    await server["handleIdeSocketRequest"](request, "socket-session");
    return "RESOLVED";
  } catch (error) {
    return (error as Error).message;
  } finally {
    configurable.mockRestore();
  }
}
