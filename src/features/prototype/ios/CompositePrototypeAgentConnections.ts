import type { PrototypeAgentConnections } from "./iosPrototypeTransport";
import { type PrototypeAgentClient } from "./prototypeAgentClient";

export class CompositePrototypeAgentConnections implements PrototypeAgentConnections {
  constructor(
    private readonly viewer: PrototypeAgentConnections,
    private readonly injected: PrototypeAgentConnections,
  ) {}
  get(deviceId: string): PrototypeAgentClient | undefined {
    return this.viewer.get(deviceId) ?? this.injected.get(deviceId);
  }
}
