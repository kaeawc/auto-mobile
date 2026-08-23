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
