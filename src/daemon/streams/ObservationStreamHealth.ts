export interface ObservationStreamHealth {
  isHealthy(): boolean;
  recover(): Promise<void>;
}

export interface ObservationStreamHealthServer {
  isListening(): boolean;
  hasActiveSocketPath(): boolean;
}

export interface ObservationStreamHealthDependencies {
  getServer(): ObservationStreamHealthServer | null;
  stopServer(): Promise<void>;
  startServer(): Promise<void>;
  configureCallbacks(): void;
}

export class DefaultObservationStreamHealth implements ObservationStreamHealth {
  constructor(private readonly dependencies: ObservationStreamHealthDependencies) {}

  isHealthy(): boolean {
    const server = this.dependencies.getServer();
    return server !== null && server.isListening() && server.hasActiveSocketPath();
  }

  async recover(): Promise<void> {
    await this.dependencies.stopServer();
    await this.dependencies.startServer();
    this.dependencies.configureCallbacks();
  }
}
