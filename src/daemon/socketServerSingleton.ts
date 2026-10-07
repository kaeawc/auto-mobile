/** The module wrappers retain failed starts/closes and clear only after close succeeds. */
export interface SocketServerLifecycle {
  isListening(): boolean;
  start(): Promise<void>;
  close(): Promise<void>;
}

export class SocketServerSingleton<T extends SocketServerLifecycle> {
  instance: T | null = null;

  async start(create: () => T): Promise<T> {
    if (!this.instance) {
      this.instance = create();
    }
    if (!this.instance.isListening()) {
      await this.instance.start();
    }
    return this.instance;
  }

  async stop(): Promise<void> {
    if (!this.instance) {
      return;
    }
    await this.instance.close();
    this.instance = null;
  }
}
