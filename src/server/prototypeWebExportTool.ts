import { z } from "zod/v4";
import { lazyFeatureModule, type LazyFeatureModule } from "../utils/lazyFeatureModule";
import { createStructuredToolResponse } from "../utils/toolUtils";
import {
  defaultPrototypeWebSources,
  prototypeResourceReadersModule,
  type PrototypeResourceReaders,
  type PrototypeWebSources,
} from "./prototypeResources";
import type { PrototypeWebExportFiles } from "./prototypeWebExport";
import { ToolRegistry } from "./toolRegistry";

export const EXPORT_PROTOTYPE_WEB_TOOL_NAME = "exportPrototypeWeb";

export const exportPrototypeWebSchema = z
  .object({
    id: z.string().min(1).describe("Shown prototype id"),
    frame: z.string().optional().describe("Device frame id"),
    revision: z.string().optional().describe("Kept spec revision (default latest)"),
    variant: z.string().optional().describe("Variant id shown first"),
    mcpSessionId: z.string().optional().describe("Only this MCP session's revisions"),
    outputPath: z
      .string()
      .optional()
      .describe("Absolute .html file or directory (default: AutoMobile data dir)"),
    overwrite: z.boolean().optional().describe("Replace a different existing file"),
    sessionUuid: z.string().optional().describe("Session"),
  })
  .strict();

export const exportPrototypeWebOutputSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  frame: z.string(),
  revision: z.number(),
  variants: z.array(z.string()),
  rendererVersion: z.string(),
});

const DESCRIPTION =
  "Write the automobile:prototype/<id>/web page (same bytes, offline, same CSP) to an HTML file; returns its path and sha256, not the HTML. Refuses to replace a different existing file without overwrite.";

type ExportModule = typeof import("./prototypeWebExport");
type FilesModule = typeof import("./NodePrototypeWebExportFiles");

/** The export code and its default files, imported on the tool's first call (#17709). */
const exportModule: LazyFeatureModule<{ exporter: ExportModule; files: FilesModule }> =
  lazyFeatureModule("prototype web export", async () => ({
    exporter: await import("./prototypeWebExport"),
    files: await import("./NodePrototypeWebExportFiles"),
  }));

export interface ExportPrototypeWebToolDependencies {
  sources?: PrototypeWebSources;
  readers?: LazyFeatureModule<PrototypeResourceReaders>;
  files?: PrototypeWebExportFiles;
}

export function registerPrototypeWebExportTool(
  dependencies: ExportPrototypeWebToolDependencies = {},
): void {
  const readers = dependencies.readers ?? prototypeResourceReadersModule;
  let sources = dependencies.sources;
  const handler = async (args: z.infer<typeof exportPrototypeWebSchema>) => {
    const { exporter, files } = await exportModule.load();
    sources ??= defaultPrototypeWebSources();
    const webSources = sources;
    // sessionUuid only routes the call; the export reads its own fields.
    const result = await exporter.exportPrototypeWeb(args, {
      readWeb: async (query) => (await readers.load()).readWeb(webSources, query),
      files: dependencies.files ?? new files.NodePrototypeWebExportFiles(),
    });
    return createStructuredToolResponse(result);
  };
  ToolRegistry.register(EXPORT_PROTOTYPE_WEB_TOOL_NAME, DESCRIPTION, exportPrototypeWebSchema, {
    handler,
    defaultEnabled: false,
    outputSchema: exportPrototypeWebOutputSchema,
  });
}
