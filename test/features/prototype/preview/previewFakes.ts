import type {
  PreviewHttpBinder,
  PreviewHttpHandler,
  PreviewHttpListener,
  PreviewHttpResponse,
} from "../../../../src/features/prototype/preview/prototypePreviewHttp";
import type {
  PrototypePreviewPageQuery,
  PrototypePreviewPageSource,
} from "../../../../src/features/prototype/preview/prototypePreviewSource";

/** A recorded response; `closeClient` simulates the browser going away. */
export class FakePreviewResponse implements PreviewHttpResponse {
  status: number | undefined;
  headers: Readonly<Record<string, string>> = {};
  readonly chunks: string[] = [];
  ended = false;
  private readonly closeListeners: (() => void)[] = [];
  private readonly settled: Promise<void>;
  private settle: () => void = () => {};

  constructor() {
    this.settled = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  writeHead(status: number, headers: Readonly<Record<string, string>>): void {
    this.status = status;
    this.headers = headers;
  }

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  end(body?: string): void {
    if (body !== undefined) {
      this.chunks.push(body);
    }
    this.ended = true;
    this.settle();
    this.closeClient();
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  closeClient(): void {
    this.closeListeners.splice(0).forEach((listener) => listener());
  }

  get body(): string {
    return this.chunks.join("");
  }

  /** Resolves when the response ended. */
  done(): Promise<void> {
    return this.settled;
  }
}

/** Calls the bound handler in process: no socket. */
export class FakePreviewHttpBinder implements PreviewHttpBinder {
  handler: PreviewHttpHandler | undefined;
  readonly binds: { host: string; port: number }[] = [];
  closed = 0;
  failWith: unknown;
  private nextPort = 40_000;

  async listen(
    address: { host: string; port: number },
    handler: PreviewHttpHandler,
  ): Promise<PreviewHttpListener> {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    this.binds.push(address);
    this.handler = handler;
    const port = address.port === 0 ? this.nextPort++ : address.port;
    return {
      port,
      close: async () => {
        this.closed += 1;
        this.handler = undefined;
      },
    };
  }

  request(url: string, options: { method?: string; host?: string } = {}): FakePreviewResponse {
    const response = new FakePreviewResponse();
    const handler = this.handler;
    if (handler === undefined) {
      throw new Error("not listening");
    }
    handler({ method: options.method ?? "GET", url, host: options.host }, response);
    return response;
  }
}

/** Pages are `<page id variant frame>` strings; `change` fires the listeners. */
export class FakePreviewPageSource implements PrototypePreviewPageSource {
  readonly known = new Set<string>();
  readonly groups = new Map<string, readonly string[]>();
  private readonly listeners = new Set<(id: string) => void>();
  failPage: Error | undefined;

  ids(): readonly string[] {
    return [...this.known];
  }

  has(id: string): boolean {
    return this.known.has(id);
  }

  related(id: string): readonly string[] {
    return this.groups.get(id) ?? [id];
  }

  async page(query: PrototypePreviewPageQuery): Promise<string> {
    if (this.failPage) {
      throw this.failPage;
    }
    return `<page ${query.id} ${query.variant ?? "-"} ${query.frame ?? "-"}>`;
  }

  onChange(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  change(id: string): void {
    this.known.add(id);
    this.listeners.forEach((listener) => listener(id));
  }
}
