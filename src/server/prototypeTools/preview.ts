import { setDaemonPrototypePreview } from "../../features/prototype/preview/daemonPrototypePreview";
import { nodePreviewHttpBinder } from "../../features/prototype/preview/prototypePreviewHttp";
import {
  PrototypePreviewServer,
  type PrototypePreviewControl,
} from "../../features/prototype/preview/PrototypePreviewServer";
import {
  revisionPreviewPageSource,
  type PrototypePreviewPageSource,
} from "../../features/prototype/preview/prototypePreviewSource";
import { readPrototypeWebResource } from "../../features/prototype/web/prototypeWebResource";
import { toActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { defaultTimer } from "../../utils/SystemTimer";
import { defaultPrototypeWebSources, type PrototypeWebSources } from "../prototypeResources";
import type { prototypeSchema } from "./schemas";
import type { PrototypeOutput } from "./types";
import type { z } from "zod/v4";

/** The preview server the tool drives and what it asks of the page source (#17975). */
export interface PrototypePreviewBinding {
  readonly server: PrototypePreviewControl;
  readonly source: Pick<PrototypePreviewPageSource, "has">;
}

/** The page source over the web resource's own sources: the page is that resource's HTML. */
export function webResourcePreviewSource(web: PrototypeWebSources): PrototypePreviewPageSource {
  return revisionPreviewPageSource(web.revisions, async (query) => {
    const page = await readPrototypeWebResource(
      web.revisions,
      query,
      web.rendererVersion(),
      web.images,
    );
    return page.html;
  });
}

let daemonBinding: PrototypePreviewBinding | undefined;

/** The daemon's one preview server, created (unbound) on first use and stopped on shutdown. */
export function daemonPrototypePreviewBinding(): PrototypePreviewBinding {
  if (daemonBinding === undefined) {
    const source = webResourcePreviewSource(defaultPrototypeWebSources());
    const server = new PrototypePreviewServer({
      source,
      http: nodePreviewHttpBinder,
      timer: defaultTimer,
    });
    setDaemonPrototypePreview(server);
    daemonBinding = { server, source };
  }
  return daemonBinding;
}

export const isPrototypePreviewAction = (action: string): action is "serve" | "stop" =>
  action === "serve" || action === "stop";

/** serve and stop: host-only, no device request. */
export async function prototypePreviewOutput(
  preview: PrototypePreviewBinding,
  args: z.infer<typeof prototypeSchema>,
): Promise<PrototypeOutput> {
  try {
    if (args.action === "stop") {
      return { success: true, previewServer: await preview.server.stop() };
    }
    const info = await preview.server.serve({
      port: args.port,
      remote: args.remote,
      idleTimeoutMs: args.idleTimeoutMs,
    });
    const pageUrl = args.id === undefined ? undefined : preview.server.pageUrl(args.id);
    const unknown = args.id !== undefined && !preview.source.has(args.id);
    return {
      success: true,
      previewServer: { ...info, ...(pageUrl ? { pageUrl } : {}) },
      ...(unknown
        ? {
            warning: `Prototype "${args.id}" has no web output yet; its page loads once it is shown.`,
          }
        : {}),
    };
  } catch (error) {
    logger.warn(`Prototype ${args.action} failed`, error);
    return {
      success: false,
      error: toActionableError(error, `Prototype ${args.action} failed`).message,
    };
  }
}
