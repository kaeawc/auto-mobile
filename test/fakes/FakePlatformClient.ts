import type { BootedDevice } from "../../src/models";
import type { CtrlProxyClient } from "../../src/features/observe/interfaces/CtrlProxyClient";
import type { PlatformClient } from "../../src/utils/interfaces/PlatformClient";
import { FakeNotificationUIDetector } from "./FakeNotificationUIDetector";
import { FakeSystemConfigurationAdapter } from "./FakeSystemConfigurationAdapter";
import { FakeTapStrategy } from "./FakeTapStrategy";

/**
 * Minimal composition fake for {@link PlatformClient}. Holds the
 * already-existing sub-fakes (`FakeTapStrategy`,
 * `FakeSystemConfigurationAdapter`, `FakeNotificationUIDetector`) and
 * exposes them through the facade's readonly fields.
 *
 * Tests should reach for the sub-fake (e.g. `.tapStrategy.wasMethodCalled(...)`)
 * to inspect interactions — this fake intentionally doesn't add its own
 * recording layer.
 *
 * `ctrlProxy` is left as a placeholder cast: most facade-aware call
 * sites that need a real-ish CtrlProxy already use `FakeCtrlProxy` for
 * the Android surface; passing a custom one via the constructor is the
 * right thing when the test exercises CtrlProxy behaviour.
 */
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
    }> = {}
  ) {
    this.device =
      device ??
      ({
        deviceId: "fake-device",
        name: "Fake",
        platform: "android",
      } as BootedDevice);
    this.ctrlProxy =
      overrides.ctrlProxy ??
      ({} as CtrlProxyClient); // Placeholder; tests that exercise CtrlProxy should inject their own.
    this.tapStrategy = overrides.tapStrategy ?? new FakeTapStrategy();
    this.systemConfiguration =
      overrides.systemConfiguration ?? new FakeSystemConfigurationAdapter();
    this.notificationUI =
      overrides.notificationUI ?? new FakeNotificationUIDetector(this.device);
  }
}
