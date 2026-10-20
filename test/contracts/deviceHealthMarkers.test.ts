import {
  type DeviceHealthMarkers,
  InMemoryDeviceHealthMarkers,
} from "../../src/daemon/deviceHealthMarkers";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeTimer } from "../fakes/FakeTimer";
import { runDeviceHealthMarkersContract } from "./DeviceHealthMarkersContract";

function harness(create: (timer: FakeTimer) => DeviceHealthMarkers) {
  return () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    return {
      markers: create(timer),
      advance: (ms: number) => timer.advanceTime(ms),
      now: () => timer.now(),
    };
  };
}

runDeviceHealthMarkersContract(
  "InMemoryDeviceHealthMarkers",
  harness((timer) => new InMemoryDeviceHealthMarkers(timer)),
);

runDeviceHealthMarkersContract(
  "FakeDeviceHealthMarkers",
  harness((timer) => new FakeDeviceHealthMarkers(timer)),
);
