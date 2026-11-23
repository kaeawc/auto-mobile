import { parser } from "sax";
import { SUMMARY_MAX_ITEMS } from "./PerformanceTraceSummary";

export interface TimeProfileStreamSummary {
  sampleCount: number;
  topFunctions: Array<{ name: string; samples: number }>;
}

interface Container {
  tag: string;
  id?: string;
  ref?: string;
  frameLeaf?: string;
  wrappedLeaf?: string;
  hasWrapped: boolean;
}

function isUsableName(name: string | undefined): name is string {
  return Boolean(name) && name !== "<deduplicated_symbol>" && !/^0x[0-9a-f]+$/i.test(name ?? "");
}

/**
 * Stream a `time-profile` export and keep only per-function sample counts, so memory stays bounded
 * by the number of distinct frames and backtraces instead of the table size (#18791: 110 MB for 10 s).
 * Mirrors the in-memory reader: the leaf is the first symbolicated frame of the row's backtrace,
 * with xctrace's `ref` cells resolved to the first occurrence (which always precedes its refs).
 */
export async function summarizeTimeProfileStream(
  chunks: AsyncIterable<string | Uint8Array>,
  signal?: AbortSignal,
): Promise<TimeProfileStreamSummary> {
  const frameNames = new Map<string, string | undefined>();
  const leafById = new Map<string, string | undefined>();
  const counts = new Map<string, number>();
  const stack: Container[] = [];
  let sampleCount = 0;
  let rowLeaf: string | undefined;
  let rowBacktraceLeaf: string | undefined;
  let rowHasBacktrace = false;
  let inRow = false;

  const xml = parser(true);
  let failure: Error | undefined;
  xml.onerror = (error) => {
    failure = error;
  };
  const parent = () => stack.at(-1);
  const isContainer = (tag: string) => tag === "tagged-backtrace" || tag === "backtrace";

  const openFrame = (attributes: Record<string, string>) => {
    const frameName = attributes.ref ? frameNames.get(attributes.ref) : attributes.name;
    if (attributes.id) {
      frameNames.set(attributes.id, frameName);
    }
    const container = parent();
    if (container && container.frameLeaf === undefined && isUsableName(frameName)) {
      container.frameLeaf = frameName;
    }
  };

  xml.onopentag = ({ name, attributes }) => {
    if (name === "row") {
      inRow = true;
      sampleCount += 1;
      rowLeaf = undefined;
      rowBacktraceLeaf = undefined;
      rowHasBacktrace = false;
    } else if (inRow && isContainer(name)) {
      stack.push({
        tag: name,
        id: attributes.id,
        ref: attributes.ref,
        hasWrapped: false,
      });
    } else if (inRow && name === "frame") {
      openFrame(attributes);
    }
  };

  const closeContainer = (container: Container) => {
    const own = container.ref ? leafById.get(container.ref) : container.frameLeaf;
    const effective =
      container.tag === "tagged-backtrace" && container.hasWrapped ? container.wrappedLeaf : own;
    if (container.id) {
      leafById.set(container.id, container.tag === "backtrace" ? own : effective);
    }
    const outer = parent();
    if (outer) {
      outer.hasWrapped = true;
      outer.wrappedLeaf = own;
    } else if (container.tag === "backtrace") {
      rowHasBacktrace = true;
      rowBacktraceLeaf = own;
    } else if (!rowHasBacktrace) {
      rowLeaf = effective;
    }
  };

  xml.onclosetag = (name) => {
    if (inRow && isContainer(name)) {
      const container = stack.pop();
      if (container) {
        closeContainer(container);
      }
    } else if (name === "row") {
      inRow = false;
      const leaf = rowHasBacktrace ? rowBacktraceLeaf : rowLeaf;
      if (leaf) {
        counts.set(leaf, (counts.get(leaf) ?? 0) + 1);
      }
    }
  };

  const decoder = new TextDecoder();
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    xml.write(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    if (failure) {
      throw failure;
    }
  }
  xml.close();
  if (failure) {
    throw failure;
  }
  return {
    sampleCount,
    topFunctions: [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, SUMMARY_MAX_ITEMS)
      .map(([name, samples]) => ({ name, samples })),
  };
}
