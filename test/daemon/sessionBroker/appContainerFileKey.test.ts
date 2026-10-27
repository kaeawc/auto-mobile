import { expect, test } from "bun:test";
import {
  appContainerFileAppId,
  legacyAppContainerFileKey,
  scopedAppFileKey,
} from "../../../src/daemon/sessionBroker/mutations/appContainerFileKey";
import { deviceToolMutations } from "../../../src/server/deviceMutationAdapters";

test.each([
  '["app","documents","a.txt"]',
  '["app_containers","app","documents",null,"default","a.txt"]',
  '["app_containers","app","documents",null,"default","namespace-reset"]',
])("decodes app container key %s", (key) => expect(appContainerFileAppId(key)).toBe("app"));

test.each([
  '["user_files","app","documents",null,"default","a.txt"]',
  '["media_library","app","documents",null,"default","a.txt"]',
  "broken",
  "{}",
  "null",
  "[]",
  '["app","documents"]',
  '["","documents","a.txt"]',
  '[1,"documents","a.txt"]',
  '["app_containers",null,"documents",null,"default","a"]',
  '["media_library",null,null,null,"default"]',
  '["app","documents","a","extra"]',
  '["app","","a.txt"]',
  '["app","documents",1]',
  '["app_containers","app","documents",null,"default"]',
])("fails closed for %s", (key) => expect(appContainerFileAppId(key)).toBeUndefined());

test("tool keys retain persisted bytes and decode only app-private writes", () => {
  const cases = [
    {
      args: { appId: "app", container: "documents", destinationPath: "a.txt" },
      key: '["app","documents","a.txt"]',
      app: "app",
    },
    {
      args: {
        target: { domain: "app_containers", appId: "app", container: "documents" },
        files: [{ destinationPath: "a.txt" }],
      },
      key: '["app_containers","app","documents",null,"default","a.txt"]',
      app: "app",
    },
    {
      args: {
        target: { domain: "user_files", namespace: "ns" },
        files: [{ destinationPath: "a.txt" }],
      },
      key: '["user_files",null,null,"ns","default","a.txt"]',
      app: undefined,
    },
  ];
  for (const { args, key, app } of cases) {
    expect(deviceToolMutations("putAppFile", args)[0]?.key).toBe(key);
    expect(appContainerFileAppId(key)).toBe(app);
  }
  expect(legacyAppContainerFileKey("app", "documents", "a.txt")).toBe(cases[0]!.key);
  expect(
    scopedAppFileKey(
      { domain: "app_containers", appId: "app", container: "documents" },
      undefined,
      "a.txt",
    ),
  ).toBe(cases[1]!.key);
});
