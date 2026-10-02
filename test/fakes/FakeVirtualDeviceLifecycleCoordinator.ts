import {
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleIdentity,
  type VirtualDeviceLifecycleLease,
  type VirtualDeviceLifecycleReservationOptions,
} from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { FakeTimer } from "./FakeTimer";

export interface RecordedLifecycleReservation {
  identity: VirtualDeviceLifecycleIdentity;
  operation: VirtualDeviceLifecycleReservationOptions["operation"];
}

export class FakeVirtualDeviceLifecycleCoordinator implements VirtualDeviceLifecycleCoordinator {
  readonly timer = new FakeTimer();
  readonly reservations: RecordedLifecycleReservation[] = [];
  private readonly coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(this.timer);

  isReserved(identity: VirtualDeviceLifecycleIdentity): boolean {
    return this.coordinator.isReserved(identity);
  }

  async reserve(
    identity: VirtualDeviceLifecycleIdentity,
    options: VirtualDeviceLifecycleReservationOptions,
  ): Promise<VirtualDeviceLifecycleLease> {
    this.reservations.push({ identity, operation: options.operation });
    return await this.coordinator.reserve(identity, options);
  }
}
