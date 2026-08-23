import type { BootedDevice } from "../../src/models";
import type { CtrlProxyClient } from "../../src/features/observe/interfaces/CtrlProxyClient";
import type { PlatformClient } from "../../src/utils/interfaces/PlatformClient";
import { FakeNotificationUIDetector } from "./FakeNotificationUIDetector";
import { FakeSystemConfigurationAdapter } from "./FakeSystemConfigurationAdapter";
import { FakeTapStrategy } from "./FakeTapStrategy";

/**
 * Composition fake for {@link PlatformClient}. Holds the existing
 * sub-fakes (`FakeTapStrategy`, `FakeSystemConfigurationAdapter`,
 * `FakeNotificationUIDetector`) and exposes them through the facade's
 * readonly fields. Tests should reach for the sub-fake
 * (e.g. `.tapStrategy.wasMethodCalled(...)`) to inspect interactions —
 * this fake intentionally doesn't add its own recording layer.
 *
 * The default `ctrlProxy` is a Proxy that throws on any access with a
 * pointed error, so tests that inadvertently touch it (without passing
 * an `overrides.ctrlProxy`) get a clear failure rather than a silent
 * `undefined is not a function`.
 */

const throwingCtrlProxy = (): CtrlProxyClient =>
  new Proxy({} as CtrlProxyClient, {
    get(_target, prop) {
      throw new Error(
        `FakePlatformClient.ctrlProxy was accessed (.${String(prop)}) but no CtrlProxy was injected. ` +
          "Pass `overrides.ctrlProxy` to the FakePlatformClient constructor.",
      );
    },
  });

export class FakePlatformClient implements PlatformClient {
  readonly device: BootedDevice;
  readonly ctrlProxy: CtrlProxyClient;
  readonly tapStrategy: FakeTapStrategy;
  readonly systemConfiguration: FakeSystemConfigurationAdapter;
  readonly notificationUI: FakeNotificationUIDetector;

  constructor(
    device?: BootedDevice,
    overrides: Partial<{
      ctrlProxy: CtrlProxyClient;
      tapStrategy: FakeTapStrategy;
      systemConfiguration: FakeSystemConfigurationAdapter;
      notificationUI: FakeNotificationUIDetector;
    }> = {},
  ) {
    this.device =
      device ??
      ({
        deviceId: "fake-device",
        name: "Fake",
        platform: "android",
      } as BootedDevice);
    this.ctrlProxy = overrides.ctrlProxy ?? throwingCtrlProxy();
    this.tapStrategy = overrides.tapStrategy ?? new FakeTapStrategy();
    this.systemConfiguration =
      overrides.systemConfiguration ?? new FakeSystemConfigurationAdapter();
    this.notificationUI = overrides.notificationUI ?? new FakeNotificationUIDetector(this.device);
  }
}
