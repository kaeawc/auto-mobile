import { describe, expect, test } from "bun:test";
import {
  SESSION_LOG_DEFAULT_MAX_BYTES,
  SESSION_LOG_MAX_BYTES_LIMIT,
  SESSION_LOG_MAX_PATHS,
  SESSION_LOG_RESOURCE_TEMPLATE,
  buildSessionLogResourceUri,
  normalizeAppGroupId,
  normalizeSessionLogAppId,
  normalizeSessionLogPaths,
  parseSessionLogQuery,
  resetAppLogsSchema,
} from "../../src/server/sessionLogContract";
import { ResourceRegistry } from "../../src/server/resourceRegistry";

describe("session log contract (#7006)", () => {
  test("parses every source from one bounded query", () => {
    const request = parseSessionLogQuery("com.example.app", {
      container: "cache",
      paths: JSON.stringify(["logs/app.log", "logs/net.log"]),
      groupId: "group.com.example.shared",
      groupPaths: JSON.stringify(["Logs/extension.log"]),
      lastSeconds: "120",
      level: "info",
      maxBytes: "1024",
    });

    expect(request).toEqual({
      appId: "com.example.app",
      maxBytes: 1024,
      files: { container: "cache", paths: ["logs/app.log", "logs/net.log"] },
      appGroup: { groupId: "group.com.example.shared", paths: ["Logs/extension.log"] },
      unifiedLog: { lastSeconds: 120, level: "info" },
    });
  });

  test("defaults the container, level and byte bound", () => {
    const request = parseSessionLogQuery("com.example.app", {
      paths: JSON.stringify(["app.log"]),
      lastSeconds: "30",
    });
    expect(request.files).toEqual({ container: "documents", paths: ["app.log"] });
    expect(request.unifiedLog).toEqual({ lastSeconds: 30, level: "default" });
    expect(request.maxBytes).toBe(SESSION_LOG_DEFAULT_MAX_BYTES);
  });

  test("rejects an empty request, unknown keys, and dangling modifiers", () => {
    expect(() => parseSessionLogQuery("com.example.app", {})).toThrow(/at least one source/);
    expect(() =>
      parseSessionLogQuery("com.example.app", { paths: JSON.stringify(["a.log"]), bogus: "1" }),
    ).toThrow(/Unknown session log query parameter: bogus/);
    expect(() => parseSessionLogQuery("com.example.app", { container: "cache" })).toThrow(
      /container requires paths/,
    );
    expect(() => parseSessionLogQuery("com.example.app", { groupPaths: "a.log" })).toThrow(
      /groupPaths requires groupId/,
    );
    expect(() => parseSessionLogQuery("com.example.app", { level: "debug" })).toThrow(
      /level requires lastSeconds/,
    );
  });

  test("rejects path traversal in every path-bearing parameter", () => {
    expect(() =>
      parseSessionLogQuery("com.example.app", { paths: JSON.stringify(["../shared/app.log"]) }),
    ).toThrow(/'\.\.' segments/);
    expect(() =>
      parseSessionLogQuery("com.example.app", { paths: JSON.stringify(["/data/app.log"]) }),
    ).toThrow(/relative path/);
    expect(() =>
      parseSessionLogQuery("com.example.app", {
        groupId: "group.shared",
        groupPaths: JSON.stringify(["..\\x"]),
      }),
    ).toThrow(/'\.\.' segments/);
    expect(() =>
      parseSessionLogQuery("com.example.app", {
        groupId: "../group",
        paths: JSON.stringify(["a"]),
      }),
    ).toThrow(/groupId must be/);
    expect(() => parseSessionLogQuery("../etc", { paths: JSON.stringify(["a.log"]) })).toThrow(
      /appId must be/,
    );
    expect(() => normalizeSessionLogAppId('com.example"; rm')).toThrow(/appId must be/);
    expect(() => normalizeAppGroupId("group..shared")).toThrow(/groupId must be/);
  });

  test("rejects unbounded reads and windows", () => {
    expect(() =>
      parseSessionLogQuery("com.example.app", { paths: JSON.stringify(["a"]), maxBytes: "0" }),
    ).toThrow(/Invalid maxBytes/);
    expect(() =>
      parseSessionLogQuery("com.example.app", {
        paths: JSON.stringify(["a"]),
        maxBytes: String(SESSION_LOG_MAX_BYTES_LIMIT + 1),
      }),
    ).toThrow(/Invalid maxBytes/);
    expect(() => parseSessionLogQuery("com.example.app", { lastSeconds: "0" })).toThrow(
      /Invalid lastSeconds/,
    );
    expect(() => parseSessionLogQuery("com.example.app", { lastSeconds: "3601" })).toThrow(
      /Invalid lastSeconds/,
    );
    expect(() => parseSessionLogQuery("com.example.app", { lastSeconds: "5m" })).toThrow(
      /Invalid lastSeconds/,
    );
    const tooMany = Array.from({ length: SESSION_LOG_MAX_PATHS + 1 }, (_, i) => `log-${i}`);
    expect(() => normalizeSessionLogPaths(tooMany)).toThrow(/at most 32/);
    expect(() => normalizeSessionLogPaths([])).toThrow(/at least one/);
  });

  test("normalizes and de-duplicates named paths in request order", () => {
    expect(normalizeSessionLogPaths(["./logs/a.log", "logs\\b.log", "logs/a.log"])).toEqual([
      "logs/a.log",
      "logs/b.log",
    ]);
  });

  test("builds a URI the registry template matches and round-trips", () => {
    ResourceRegistry.clearResources();
    ResourceRegistry.registerTemplate(
      SESSION_LOG_RESOURCE_TEMPLATE,
      "x",
      "x",
      "application/json",
      async () => ({ uri: "x" }),
    );
    const request = parseSessionLogQuery("com.example.app", {
      paths: JSON.stringify(["logs/app.log", "logs/net.log"]),
      groupId: "group.com.example.shared",
      lastSeconds: "60",
    });
    const uri = buildSessionLogResourceUri("session 1", request);
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();
    const { sessionUuid, appId, ...query } = match!.params;
    expect(decodeURIComponent(sessionUuid)).toBe("session 1");
    expect(parseSessionLogQuery(appId, query)).toEqual(request);
    ResourceRegistry.clearResources();
  });

  test("round-trips a files path containing a comma", () => {
    ResourceRegistry.clearResources();
    ResourceRegistry.registerTemplate(
      SESSION_LOG_RESOURCE_TEMPLATE,
      "x",
      "x",
      "application/json",
      async () => ({ uri: "x" }),
    );
    const request = {
      appId: "com.example.app",
      maxBytes: SESSION_LOG_DEFAULT_MAX_BYTES,
      files: { container: "documents" as const, paths: ["a,b.log"] },
    };
    const uri = buildSessionLogResourceUri("session-1", request);
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();
    const { appId, sessionUuid, ...query } = match!.params;
    expect(sessionUuid).toBe("session-1");
    expect(parseSessionLogQuery(appId, query)).toEqual(request);
    ResourceRegistry.clearResources();
  });

  test("round-trips an app group path containing a comma", () => {
    ResourceRegistry.clearResources();
    ResourceRegistry.registerTemplate(
      SESSION_LOG_RESOURCE_TEMPLATE,
      "x",
      "x",
      "application/json",
      async () => ({ uri: "x" }),
    );
    const request = {
      appId: "com.example.app",
      maxBytes: SESSION_LOG_DEFAULT_MAX_BYTES,
      appGroup: { groupId: "group.com.example.shared", paths: ["a,b.log"] },
    };
    const uri = buildSessionLogResourceUri("session-1", request);
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();
    const { appId, sessionUuid, ...query } = match!.params;
    expect(sessionUuid).toBe("session-1");
    expect(parseSessionLogQuery(appId, query)).toEqual(request);
    ResourceRegistry.clearResources();
  });

  test("round-trips multiple files paths", () => {
    ResourceRegistry.clearResources();
    ResourceRegistry.registerTemplate(
      SESSION_LOG_RESOURCE_TEMPLATE,
      "x",
      "x",
      "application/json",
      async () => ({ uri: "x" }),
    );
    const request = {
      appId: "com.example.app",
      maxBytes: SESSION_LOG_DEFAULT_MAX_BYTES,
      files: { container: "documents" as const, paths: ["a.log", "b.log", "c.log"] },
    };
    const uri = buildSessionLogResourceUri("session-1", request);
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();
    const { appId, sessionUuid, ...query } = match!.params;
    expect(sessionUuid).toBe("session-1");
    expect(parseSessionLogQuery(appId, query)).toEqual(request);
    ResourceRegistry.clearResources();
  });

  test("round-trips files paths with spaces and percent characters", () => {
    ResourceRegistry.clearResources();
    ResourceRegistry.registerTemplate(
      SESSION_LOG_RESOURCE_TEMPLATE,
      "x",
      "x",
      "application/json",
      async () => ({ uri: "x" }),
    );
    const request = {
      appId: "com.example.app",
      maxBytes: SESSION_LOG_DEFAULT_MAX_BYTES,
      files: { container: "documents" as const, paths: ["log file.log", "100%.log"] },
    };
    const uri = buildSessionLogResourceUri("session-1", request);
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();
    const { appId, sessionUuid, ...query } = match!.params;
    expect(sessionUuid).toBe("session-1");
    expect(parseSessionLogQuery(appId, query)).toEqual(request);
    ResourceRegistry.clearResources();
  });

  test("rejects malformed JSON path lists", () => {
    expect(() => parseSessionLogQuery("com.example.app", { paths: '["bad.log"' })).toThrow(
      /paths must be a JSON array of path strings/,
    );
    expect(() =>
      parseSessionLogQuery("com.example.app", {
        groupId: "group.com.example.shared",
        groupPaths: '{"not":"an array"}',
      }),
    ).toThrow(/groupPaths must be a JSON array of path strings/);
  });

  test("parses an independently single-encoded files path containing a comma", () => {
    ResourceRegistry.clearResources();
    ResourceRegistry.registerTemplate(
      SESSION_LOG_RESOURCE_TEMPLATE,
      "x",
      "x",
      "application/json",
      async () => ({ uri: "x" }),
    );
    const paths = ["a,b.log"];
    const query = new URLSearchParams({
      container: "documents",
      paths: JSON.stringify(paths),
      maxBytes: String(SESSION_LOG_DEFAULT_MAX_BYTES),
    });
    const match = ResourceRegistry.matchTemplate(
      `automobile:device-session/session-1/apps/com.example.app/logs?${query.toString()}`,
    );
    expect(match).toBeDefined();
    const { appId, sessionUuid, ...params } = match!.params;
    expect(sessionUuid).toBe("session-1");
    expect(parseSessionLogQuery(appId, params).files).toEqual({ container: "documents", paths });
    ResourceRegistry.clearResources();
  });

  test("parses independently single-encoded multiple files paths containing a comma and space", () => {
    ResourceRegistry.clearResources();
    ResourceRegistry.registerTemplate(
      SESSION_LOG_RESOURCE_TEMPLATE,
      "x",
      "x",
      "application/json",
      async () => ({ uri: "x" }),
    );
    const paths = ["a,b.log", "plain.log", "log file.log"];
    const query = new URLSearchParams({
      container: "documents",
      paths: JSON.stringify(paths),
      maxBytes: String(SESSION_LOG_DEFAULT_MAX_BYTES),
    });
    const match = ResourceRegistry.matchTemplate(
      `automobile:device-session/session-1/apps/com.example.app/logs?${query.toString()}`,
    );
    expect(match).toBeDefined();
    const { appId, sessionUuid, ...params } = match!.params;
    expect(sessionUuid).toBe("session-1");
    expect(parseSessionLogQuery(appId, params).files).toEqual({ container: "documents", paths });
    ResourceRegistry.clearResources();
  });

  test("parses an independently single-encoded files path with a literal percent", () => {
    ResourceRegistry.clearResources();
    ResourceRegistry.registerTemplate(
      SESSION_LOG_RESOURCE_TEMPLATE,
      "x",
      "x",
      "application/json",
      async () => ({ uri: "x" }),
    );
    const paths = ["100%.log"];
    const query = new URLSearchParams({
      container: "documents",
      paths: JSON.stringify(paths),
      maxBytes: String(SESSION_LOG_DEFAULT_MAX_BYTES),
    });
    const match = ResourceRegistry.matchTemplate(
      `automobile:device-session/session-1/apps/com.example.app/logs?${query.toString()}`,
    );
    expect(match).toBeDefined();
    const { appId, sessionUuid, ...params } = match!.params;
    expect(sessionUuid).toBe("session-1");
    expect(parseSessionLogQuery(appId, params).files).toEqual({ container: "documents", paths });
    ResourceRegistry.clearResources();
  });

  test("preserves a percent-escape-looking sequence in independently single-encoded files paths", () => {
    ResourceRegistry.clearResources();
    ResourceRegistry.registerTemplate(
      SESSION_LOG_RESOURCE_TEMPLATE,
      "x",
      "x",
      "application/json",
      async () => ({ uri: "x" }),
    );
    const paths = ["weird%41file.log"];
    const query = new URLSearchParams({
      container: "documents",
      paths: JSON.stringify(paths),
      maxBytes: String(SESSION_LOG_DEFAULT_MAX_BYTES),
    });
    const match = ResourceRegistry.matchTemplate(
      `automobile:device-session/session-1/apps/com.example.app/logs?${query.toString()}`,
    );
    expect(match).toBeDefined();
    const { appId, sessionUuid, ...params } = match!.params;
    expect(sessionUuid).toBe("session-1");
    expect(parseSessionLogQuery(appId, params).files).toEqual({ container: "documents", paths });
    ResourceRegistry.clearResources();
  });

  test("parses independently single-encoded group path lists containing commas", () => {
    ResourceRegistry.clearResources();
    ResourceRegistry.registerTemplate(
      SESSION_LOG_RESOURCE_TEMPLATE,
      "x",
      "x",
      "application/json",
      async () => ({ uri: "x" }),
    );
    const paths = ["a,b.log"];
    const query = new URLSearchParams({
      groupId: "group.com.example.shared",
      groupPaths: JSON.stringify(paths),
      maxBytes: String(SESSION_LOG_DEFAULT_MAX_BYTES),
    });
    const match = ResourceRegistry.matchTemplate(
      `automobile:device-session/session-1/apps/com.example.app/logs?${query.toString()}`,
    );
    expect(match).toBeDefined();
    const { appId, sessionUuid, ...params } = match!.params;
    expect(sessionUuid).toBe("session-1");
    expect(parseSessionLogQuery(appId, params).appGroup).toEqual({
      groupId: "group.com.example.shared",
      paths,
    });
    ResourceRegistry.clearResources();
  });

  test("resetAppLogs schema accepts aliases and rejects traversal", () => {
    expect(
      resetAppLogsSchema.parse({ bundleId: "com.example.app", paths: ["logs/app.log"] }),
    ).toMatchObject({ appId: "com.example.app", container: "documents", paths: ["logs/app.log"] });
    expect(
      resetAppLogsSchema.safeParse({ appId: "com.example.app", paths: ["../x.log"] }).success,
    ).toBe(false);
    expect(resetAppLogsSchema.safeParse({ appId: "com.example.app", paths: [] }).success).toBe(
      false,
    );
    expect(resetAppLogsSchema.safeParse({ appId: "com/evil", paths: ["a.log"] }).success).toBe(
      false,
    );
  });
});
