#!/usr/bin/env bun
import { parseArgs } from "node:util";
import contract from "../../schemas/prototype-spec-contract.json";

export const MAX_ROWS = contract.limits.MAX_PROTOTYPE_LIST_ITEMS;

export function parseFeedOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      rows: { type: "string", default: "1000" },
      out: { type: "string" },
      paging: { type: "boolean", default: false },
      "page-url": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const rowArgument = values.rows ?? "1000";
  const rows = Number(rowArgument);
  if (!/^[0-9]+$/.test(rowArgument) || !Number.isSafeInteger(rows) || rows < 1 || rows > MAX_ROWS) {
    throw new Error(`--rows must be an integer in 1..${MAX_ROWS}`);
  }
  const pageUrl = values["page-url"];
  if (values.paging !== Boolean(pageUrl)) {
    throw new Error("--paging requires --page-url URL (and --page-url requires --paging)");
  }
  if (pageUrl) {
    const url = new URL(pageUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("--page-url must be an HTTP(S) URL without credentials");
    }
  }
  return { rows, out: values.out, pageUrl };
}

export function generateFeedSpec(options: ReturnType<typeof parseFeedOptions>) {
  return {
    id: "perf-feed",
    window: { placement: { type: "fullscreen" } },
    state: { liked: false },
    data: {
      feed: {
        items: Array.from({ length: options.rows }, (_, id) => ({
          id: `post-${id}`,
          author: `User ${id}`,
          handle: `@user${id}`,
          caption: `Post ${id}: A quiet morning walk, fresh coffee, and a new view of the neighborhood.`,
          likes: id * 3,
          comments: id % 40,
        })),
      },
    },
    root: {
      type: "list",
      axis: "vertical",
      contentDescription: "Benchmark feed",
      spacing: 12,
      contentPadding: 16,
      maxItems: MAX_ROWS,
      repeat: { items: { path: "/feed/items" }, as: "post", key: "id" },
      ...(options.pageUrl
        ? {
            endThreshold: 3,
            onEndReached: [
              {
                type: "request",
                url: options.pageUrl,
                append: { from: "/items", to: "/data/feed/items" },
              },
            ],
          }
        : {}),
      children: [
        {
          type: "column",
          children: [
            {
              type: "image",
              asset: "benchmark-image",
              style: { width: { dp: 48 }, height: { dp: 48 } },
            },
            { type: "text", text: "{post.author} ({post.handle})" },
            { type: "text", text: "{post.caption}" },
            { type: "text", text: "{post.likes} likes - {post.comments} comments" },
            {
              type: "button",
              label: "Like",
              onTap: [{ type: "setState", key: "liked", value: true }],
            },
          ],
        },
      ],
    },
  };
}

if (import.meta.main) {
  try {
    const options = parseFeedOptions(process.argv.slice(2));
    const json = `${JSON.stringify(generateFeedSpec(options), null, 2)}\n`;
    if (options.out) {
      await Bun.write(options.out, json);
    } else {
      process.stdout.write(json);
    }
  } catch (error) {
    console.error(
      `generate-feed-benchmark-spec: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
