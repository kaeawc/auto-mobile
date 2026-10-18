import { MapDeviceClientRegistry } from "../../src/ctrlProxy/deviceClientRegistry";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import { FakeDeviceClientRegistry } from "../fakes/FakeDeviceClientRegistry";
import {
  runDeviceClientRegistryContract,
  type DeviceClientRegistryHarness,
} from "./DeviceClientRegistryContract";

/** The platform classes own static registries; cast only to widen the instance type to the contract's `object`. */
function shared(registry: unknown, drain: () => void): DeviceClientRegistryHarness {
  return {
    registry: registry as DeviceClientRegistryHarness["registry"],
    reset: () => {
      drain();
      (registry as MapDeviceClientRegistry<object>).clearRetired();
    },
  };
}

runDeviceClientRegistryContract("MapDeviceClientRegistry", () => {
  const registry = new MapDeviceClientRegistry<object>();
  return { registry, reset: () => registry.clearRetired() };
});

runDeviceClientRegistryContract("FakeDeviceClientRegistry", () => {
  const registry = new FakeDeviceClientRegistry<object>();
  return { registry, reset: () => registry.clearRetired() };
});

runDeviceClientRegistryContract("AndroidCtrlProxyManager.registry", () =>
  shared(AndroidCtrlProxyManager.registry, () => AndroidCtrlProxyManager.registry.closeAll()),
);

runDeviceClientRegistryContract("IOSCtrlProxyManager.registry", () =>
  shared(IOSCtrlProxyManager.registry, () => IOSCtrlProxyManager.registry.closeAll()),
);

runDeviceClientRegistryContract("AndroidCtrlProxyClient.registry", () =>
  shared(AndroidCtrlProxyClient.registry, () => AndroidCtrlProxyClient.registry.closeAll()),
);

runDeviceClientRegistryContract("IOSCtrlProxyClient.registry", () =>
  shared(IOSCtrlProxyClient.registry, () => IOSCtrlProxyClient.registry.closeAll()),
);
