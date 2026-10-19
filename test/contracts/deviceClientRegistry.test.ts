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

/** The platform classes own static registries; each is drained and its retired marks cleared between cases. */
function shared(registry: DeviceClientRegistryHarness["registry"]): DeviceClientRegistryHarness {
  return {
    registry,
    reset: () => {
      registry.closeAll();
      registry.clearRetired();
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
  shared(AndroidCtrlProxyManager.registry),
);

runDeviceClientRegistryContract("IOSCtrlProxyManager.registry", () =>
  shared(IOSCtrlProxyManager.registry),
);

runDeviceClientRegistryContract("AndroidCtrlProxyClient.registry", () =>
  shared(AndroidCtrlProxyClient.registry),
);

runDeviceClientRegistryContract("IOSCtrlProxyClient.registry", () =>
  shared(IOSCtrlProxyClient.registry),
);
