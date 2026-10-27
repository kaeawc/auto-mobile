import type {
  ShellDocument,
  ShellMessageEvent,
  ShellNode,
  ShellWindow,
} from "../../src/server/observeAppShellClient";

/** A minimal DOM: just the node operations the live observe shell is allowed to use. */
export class FakeShellNode implements ShellNode {
  readonly attributes = new Map<string, string>();
  children: FakeShellNode[] = [];
  textContent: string | null = null;
  scrollWidth?: number;
  scrollHeight?: number;
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  appendChild(child: ShellNode): unknown {
    this.children.push(child as FakeShellNode);
    return child;
  }
  replaceChildren(...children: ShellNode[]): void {
    this.children = children as FakeShellNode[];
  }
}

export class FakeShellDocument implements ShellDocument {
  readonly documentElement = new FakeShellNode("html");
  private readonly byId = new Map<string, FakeShellNode>([
    ["canvas", new FakeShellNode("svg")],
    ["status", new FakeShellNode("p")],
  ]);
  readonly created: string[] = [];
  createElementNS(_ns: string, name: string): ShellNode {
    this.created.push(name);
    return new FakeShellNode(name);
  }
  getElementById(id: string): FakeShellNode | null {
    return this.byId.get(id) ?? null;
  }
  get canvas(): FakeShellNode {
    return this.byId.get("canvas")!;
  }
  get status(): FakeShellNode {
    return this.byId.get("status")!;
  }
}

/** A window whose `parent` records posted messages and whose listeners tests can drive. */
export class FakeShellWindow implements ShellWindow {
  readonly posted: Array<{ message: Record<string, unknown>; targetOrigin: string }> = [];
  private readonly listeners: Array<(event: ShellMessageEvent) => void> = [];
  readonly parent = {
    postMessage: (message: unknown, targetOrigin: string) => {
      this.posted.push({ message: message as Record<string, unknown>, targetOrigin });
    },
  };
  addEventListener(_type: "message", listener: (event: ShellMessageEvent) => void): void {
    this.listeners.push(listener);
  }
  deliver(data: unknown, source: unknown = this.parent): void {
    for (const listener of this.listeners) {
      listener({ source, data });
    }
  }
  get methods(): string[] {
    return this.posted.flatMap(({ message }) =>
      typeof message.method === "string" ? [message.method] : [],
    );
  }
}
