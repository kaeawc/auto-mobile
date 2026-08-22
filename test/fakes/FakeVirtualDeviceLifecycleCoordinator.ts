import {
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleIdentity,
  type VirtualDeviceLifecycleLease,
  type VirtualDeviceLifecycleReservationOptions,
} from "../../src/utils/virtualDeviceLifecycleCoordinator";
import { FakeTimer } from "./FakeTimer";

export interface RecordedLifecycleReservation {
  identity: VirtualDeviceLifecycleIdentity;
  operation: VirtualDeviceLifecycleReservationOptions["operation"];
}

export class FakeVirtualDeviceLifecycleCoordinator implements VirtualDeviceLifecycleCoordinator {
  readonly timer = new FakeTimer();
  readonly reservations: RecordedLifecycleReservation[] = [];
  private readonly coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(this.timer);

  async reserve(
    identity: VirtualDeviceLifecycleIdentity,
    options: VirtualDeviceLifecycleReservationOptions,
  ): Promise<VirtualDeviceLifecycleLease> {
    this.reservations.push({ identity, operation: options.operation });
    return await this.coordinator.reserve(identity, options);
  }
}
