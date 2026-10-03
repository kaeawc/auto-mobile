import { setToolTransportRecovery } from "../../src/server/toolTransportRecovery";
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
  const previous = new Map(ToolRegistry["tools"]);
  return () => {
    const current = ToolRegistry["tools"];
    for (const [name, tool] of current) {
      if (previous.get(name) !== tool) {
        ToolRegistry.unregister(name);
      }
    }
    for (const [name, tool] of previous) {
      if (current.get(name) !== tool) {
        ToolRegistry.unregister(name);
        current.set(name, tool);
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
