import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FailureAnalyticsRepository } from "../../src/db/failureAnalyticsRepository";
import { registerFailuresResources } from "../../src/server/failuresResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { FakeMcpServer } from "../fakes/FakeMcpServer";
import { FakeTimer } from "../fakes/FakeTimer";

// Interaction of #10117 (a malformed percent-escape in a resource URI is a structured
// error; the registry converts a stray URIError to invalid-params) with #10119 (the
// failures timeline is `automobile:failures/timeline{?dateRange,aggregation}` and
// validates its query with the poll_timeline validators). A malformed escape in a
// QUERY value must reach the timeline's own validation and come back as the
// timeline's JSON error envelope — neither a throw nor the registry's McpError.

type TimelineQuery = Parameters<FailureAnalyticsRepository["getTimelineData"]>[0];

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

class FakeFailuresRepository {
  timelineQueries: TimelineQuery[] = [];
  failure: Error | undefined;

  async getFailureGroups(): ReturnType<FailureAnalyticsRepository["getFailureGroups"]> {
    return [];
  }

  async getTimelineData(
    query: TimelineQuery,
  ): ReturnType<FailureAnalyticsRepository["getTimelineData"]> {
    this.timelineQueries.push(query);
    if (this.failure) {
      throw this.failure;
    }
    return {
      dataPoints: [],
      previousPeriodTotals: { crashes: 0, anrs: 0, toolFailures: 0, nonfatals: 0 },
    };
  }
}

describe("failures timeline query vs the malformed-URI backstop (#10117 + #10119)", () => {
  let repository: FakeFailuresRepository;
  let readHandler: (request: { params: { uri: string } }, extra: object) => Promise<unknown>;

  beforeEach(() => {
    const timer = new FakeTimer();
    timer.setCurrentTime(NOW);
    repository = new FakeFailuresRepository();
    ResourceRegistry.clearResources();
    registerFailuresResources(repository, timer);
    // The #10117 backstop target: a handler that decodes its capture unguarded.
    ResourceRegistry.registerTemplate(
      "automobile:test/unguarded/{name}",
      "Unguarded",
      "Decodes its capture without a guard",
      "application/json",
      async (params) => ({ uri: "automobile:test", text: decodeURIComponent(params.name) }),
    );
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer, () => ({}));
    const handler = server.server.handlersBySchema.get(ReadResourceRequestSchema);
    if (!handler) {
      throw new Error("read handler not registered");
    }
    readHandler = handler;
  });

  afterEach(() => {
    ResourceRegistry.clearResources();
    ResourceRegistry.clearServersForTesting();
  });

  async function readTimeline(uri: string): Promise<{ error?: string; dateRange?: string }> {
    const result = (await readHandler({ params: { uri } }, {})) as {
      contents: Array<{ text?: string }>;
    };
    return JSON.parse(result.contents[0]?.text ?? "{}") as { error?: string; dateRange?: string };
  }

  test.each([
    ["a malformed escape in dateRange", "?dateRange=bad%zz", "Invalid dateRange: bad%zz"],
    ["a bare % in dateRange", "?dateRange=7%", "Invalid dateRange: 7%"],
    ["a truncated multi-byte escape in aggregation", "?aggregation=%E0%A4", "Invalid aggregation"],
    [
      "a malformed escape in the second parameter",
      "?dateRange=7d&aggregation=%zz",
      "Invalid aggregation: %zz",
    ],
    ["an unknown key", "?window=7d", "Unknown query parameters: window"],
    ["an unknown key with a malformed escape", "?window=%zz", "Unknown query parameters: window"],
  ])("%s is the timeline's own JSON error, not a throw", async (_label, query, message) => {
    const body = await readTimeline(`automobile:failures/timeline${query}`);

    expect(body.error).toContain(message);
    // Validation failed before the repository was touched.
    expect(repository.timelineQueries).toEqual([]);
  });

  test.each([
    ["dateRange", "?dateRange=%E0%A4%A", "Invalid dateRange: %E0%A4%A."],
    ["aggregation", "?aggregation=%E0%A4%A", "Invalid aggregation: %E0%A4%A."],
  ])(
    "an invalid %s echoes the raw escaped value, not a lenient decode",
    async (_key, query, message) => {
      const body = await readTimeline(`automobile:failures/timeline${query}`);

      expect(body.error).toContain(message);
      expect(body.error).not.toContain("\uFFFD");
      expect(repository.timelineQueries).toEqual([]);
    },
  );

  test("a malformed query escape does not surface as an McpError", async () => {
    const outcome = await readHandler(
      { params: { uri: "automobile:failures/timeline?dateRange=bad%zz" } },
      {},
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    expect("error" in outcome).toBe(false);
  });

  test("a percent-encoded VALID value still decodes and queries the repository", async () => {
    const body = await readTimeline("automobile:failures/timeline?dateRange=%37d&aggregation=day");

    expect(body.error).toBeUndefined();
    expect(body.dateRange).toBe("7d");
    expect(repository.timelineQueries).toHaveLength(1);
    expect(repository.timelineQueries[0]?.aggregation).toBe("day");
  });

  test("the registry backstop still turns a URIError into invalid-params next to the timeline", async () => {
    const error = await readHandler({ params: { uri: "automobile:test/unguarded/a%" } }, {}).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(-32602);
    expect((error as McpError).message).toContain("Malformed resource URI");
  });

  test("a repository failure keeps the timeline's own envelope (the backstop only matches URIError)", async () => {
    repository.failure = new Error("db down");

    const body = await readTimeline("automobile:failures/timeline?dateRange=24h");

    expect(body.error).toContain("Failed to retrieve timeline");
    expect(body.error).toContain("db down");
  });

  test("the timeline template is the query form the sweep expands", () => {
    const template = ResourceRegistry.getTemplateDefinitions().find((definition) =>
      definition.uriTemplate.startsWith("automobile:failures/timeline"),
    );

    expect(template?.uriTemplate).toBe("automobile:failures/timeline{?dateRange,aggregation}");
  });
});
