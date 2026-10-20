import { setToolTransportRecovery } from "../../src/daemon/toolTransportRecovery";
import { afterAll, beforeAll } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";

export async function withTemporaryTool<T>(
  name: string,
  register: () => void,
  run: () => Promise<T>,
): Promise<T> {
  register();
  try {
    return await run();
  } finally {
    ToolRegistry.unregister(name);
  }
}

export function unregisterTemporaryTools(...names: string[]): void {
  for (const name of names) {
    ToolRegistry.unregister(name);
  }
}

/** Undo registrations made by one file, including overrides of existing tools. */
export function preserveToolRegistry(): () => void {
  const previous = new Map(ToolRegistry.getEveryRegisteredTool().map((tool) => [tool.name, tool]));
  return () => {
    const current = new Map(ToolRegistry.getEveryRegisteredTool().map((tool) => [tool.name, tool]));
    for (const [name, tool] of current) {
      if (previous.get(name) !== tool) {
        ToolRegistry.unregister(name);
      }
    }
    for (const [name, tool] of previous) {
      if (current.get(name) !== tool) {
        ToolRegistry.unregister(name);
        ToolRegistry.setRegisteredToolForTesting(tool);
        setToolTransportRecovery(name, tool.transportRecovery);
      }
    }
  };
}

export function isolateToolRegistry(): void {
  let restore: () => void;
  beforeAll(() => {
    restore = preserveToolRegistry();
  });
  afterAll(() => restore());
}

/** Run a suite with an empty registry, then restore the exact tools it found. */
export function isolateEmptyToolRegistry(): void {
  isolateToolRegistry();
  beforeAll(() => ToolRegistry.clearTools());
}
