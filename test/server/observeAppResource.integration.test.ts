import { describe, test, expect, beforeEach } from "bun:test";
import {
  renderObserveAppHtml,
  registerObserveAppResource,
  OBSERVE_APP_RESOURCE_URI,
  MCP_APP_MIME_TYPE,
  type ObserveAppDataSource,
} from "../../src/server/observeAppResource";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import {
  loadAndroidHomeObserve,
  loadIosFractionalObserve,
} from "../fixtures/observe/observeFixture";
import type { ObserveResult } from "../../src/models/ObserveResult";
import { z } from "zod/v4";

const androidObserve = (): ObserveResult => loadAndroidHomeObserve().observe;
const iosObserve = (): ObserveResult => loadIosFractionalObserve();

// One <rect class="am-box"> is emitted per flattened element with bounds.
const countBoxes = (html: string): number => (html.match(/class="am-box"/g) || []).length;

describe("renderObserveAppHtml", () => {
  test("renders one overlay box per flattened element (Android fixture)", () => {
    const html = renderObserveAppHtml(androidObserve());
    // viewBox is the bounds coordinate space, so boxes align regardless of screenshot resolution.
    expect(html).toContain('viewBox="0 0 1080 2400"');
    expect(countBoxes(html)).toBe(58);
  });

  test("preserves fractional iOS bounds (issue #3206) — Android + iOS hierarchy shape", () => {
    const html = renderObserveAppHtml(iosObserve());
    expect(html).toContain('viewBox="0 0 393 852"');
    expect(countBoxes(html)).toBe(4);
    // 851.6666… must not be truncated to an integer.
    expect(html).toMatch(/851\.667/);
  });

  test("embeds the screenshot as an inline <image> when provided, and omits it otherwise", () => {
    const dataUri = "data:image/png;base64,QUJD";
    const withShot = renderObserveAppHtml(iosObserve(), dataUri);
    expect(withShot).toContain("<image");
    expect(withShot).toContain(dataUri);

    const noShot = renderObserveAppHtml(iosObserve());
    expect(noShot).not.toContain("<image");
  });

  test("is fully self-contained — no external fetch, CDN, or remote script", () => {
    const html = renderObserveAppHtml(androidObserve(), "data:image/png;base64,QUJD");
    // No fetchable external references: no remote scripts, no http(s)/protocol-relative
    // src/href, no CSS url()/@import, no fetch().
    expect(html).not.toMatch(/<script\s+[^>]*\bsrc=/i);
    expect(html).not.toMatch(/\b(?:src|href)=["'](?:https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/\bfetch\s*\(/);
    // The only permitted http string is the inert SVG namespace, never fetched.
    const withoutSvgNs = html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "");
    expect(withoutSvgNs).not.toMatch(/https?:\/\//);
  });

  test("is theme-aware (light + dark)", () => {
    expect(renderObserveAppHtml(iosObserve())).toContain("prefers-color-scheme");
  });

  test("degrades to an empty state without a view hierarchy (no throw)", () => {
    const empty = { screenSize: { width: 100, height: 200 } } as unknown as ObserveResult;
    const html = renderObserveAppHtml(empty);
    expect(html).toContain("data-observe-app");
    expect(countBoxes(html)).toBe(0);
  });
});

describe("registerObserveAppResource", () => {
  const fakeSource: ObserveAppDataSource = {
    getLatestObserve: async () => iosObserve(),
    getLatestScreenshotDataUri: async () => "data:image/png;base64,QUJD",
  };

  beforeEach(() => {
    ResourceRegistry.clearResources();
  });

  test("advertises ui://automobile/observe with the MCP App mime type", () => {
    registerObserveAppResource(fakeSource);
    const def = ResourceRegistry.getResourceDefinitions().find(
      (d) => d.uri === OBSERVE_APP_RESOURCE_URI,
    );
    expect(def).toBeDefined();
    expect(def?.mimeType).toBe(MCP_APP_MIME_TYPE);
  });

  test("handler renders app HTML from the data source (screenshot inlined)", async () => {
    registerObserveAppResource(fakeSource);
    const content = await ResourceRegistry.getResource(OBSERVE_APP_RESOURCE_URI)!.handler();
    expect(content.mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(content.text).toContain("data-observe-app");
    expect(content.text).toContain("data:image/png;base64,QUJD");
    expect(content.text).toContain('viewBox="0 0 393 852"');
  });
});

describe("ui:// resource resolves through the MCP read path (scheme guard)", () => {
  let fixture: McpTestFixture;

  beforeEach(() => {
    ResourceRegistry.clearResources();
  });

  test("resources/list advertises it and resources/read returns app HTML", async () => {
    fixture = new McpTestFixture();
    await fixture.setup();
    try {
      const { client } = fixture.getContext();

      const listSchema = z.object({
        resources: z.array(z.object({ uri: z.string(), mimeType: z.string().optional() })),
      });
      const list = await client.request({ method: "resources/list", params: {} }, listSchema);
      const listed = list.resources.find((r) => r.uri === OBSERVE_APP_RESOURCE_URI);
      expect(listed).toBeDefined();
      expect(listed?.mimeType).toBe(MCP_APP_MIME_TYPE);

      const readSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
          }),
        ),
      });
      const read = await client.request(
        { method: "resources/read", params: { uri: OBSERVE_APP_RESOURCE_URI } },
        readSchema,
      );
      expect(read.contents).toHaveLength(1);
      expect(read.contents[0].mimeType).toBe(MCP_APP_MIME_TYPE);
      // Empty-state or populated — either way the app root renders (guard let ui:// through).
      expect(read.contents[0].text).toContain("data-observe-app");
    } finally {
      await fixture.teardown();
    }
  });
});
