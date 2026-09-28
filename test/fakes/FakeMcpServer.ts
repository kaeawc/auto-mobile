import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FakeUnderlyingServer } from "./FakeUnderlyingServer";

type ToolHandler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<unknown>;

interface RegisteredMcpTool {
  name: string;
  config: { description?: string; inputSchema?: unknown; outputSchema?: unknown };
  handler: ToolHandler;
}

/** High-level server observer for tool and resource registration tests. */
export class FakeMcpServer implements Pick<McpServer, "sendToolListChanged"> {
  readonly server = new FakeUnderlyingServer();
  readonly registeredTools: RegisteredMcpTool[] = [];
  calls = 0;
  shouldThrow = false;

  registerTool(name: string, config: RegisteredMcpTool["config"], handler: ToolHandler): void {
    this.registeredTools.push({ name, config, handler });
  }

  getRegisteredHandler(name: string): ToolHandler | undefined {
    return this.registeredTools.find((tool) => tool.name === name)?.handler;
  }

  sendToolListChanged(): void {
    this.calls++;
    if (this.shouldThrow) {
      throw new Error("send boom");
    }
  }
}
