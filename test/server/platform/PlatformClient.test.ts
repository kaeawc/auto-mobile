import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { createPlatformClient } from "../../../src/server/platform/createPlatformClient";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios/IOSCtrlProxyClient";
import { AndroidTapStrategy } from "../../../src/features/action/strategies/AndroidTapStrategy";
import { IosTapStrategy } from "../../../src/features/action/strategies/IosTapStrategy";
import { AndroidSystemConfigurationAdapter } from "../../../src/features/utility/system-configuration/AndroidSystemConfigurationAdapter";
import { IosSystemConfigurationAdapter } from "../../../src/features/utility/system-configuration/IosSystemConfigurationAdapter";
import { AndroidNotificationUIDetector } from "../../../src/server/system-tray/AndroidNotificationUIDetector";
import { IosNotificationUIDetector } from "../../../src/server/system-tray/IosNotificationUIDetector";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { FakeProcessExecutor } from "../../fakes/FakeProcessExecutor";
import { FakePlatformClient } from "../../fakes/FakePlatformClient";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeSystemConfigurationAdapter } from "../../fakes/FakeSystemConfigurationAdapter";
import { FakeNotificationUIDetector } from "../../fakes/FakeNotificationUIDetector";
import { PortManager } from "../../../src/utils/PortManager";
import type { BootedDevice } from "../../../src/models";
import type { PlatformClient } from "../../../src/utils/interfaces/PlatformClient";

/**
 * Conformance test for the PlatformClient facade. Verifies that
 * `createPlatformClient` performs platform dispatch correctly for each
 * of the five bundled handles, that the fake satisfies the same
 * interface, and that the assembled object is structurally valid as a
 * `PlatformClient`.
 */
describe("PlatformClient", () => {
  beforeEach(() => {
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  });

  afterEach(() => {
    IOSCtrlProxyClient.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  const androidDevice: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel_5",
    platform: "android",
  };
  const iosDevice: BootedDevice = {
    deviceId: "00001234-ABCD",
    name: "iPhone 15",
    platform: "ios",
  };

  const buildOptions = () => ({
    adbFactory: new FakeAdbClientFactory(),
    accessibilityDetector: new FakeAccessibilityDetector(),
    iosVoiceOverDetector: new FakeIosVoiceOverDetector(),
    processExecutor: new FakeProcessExecutor(),
  });

  interface PlatformCase {
    name: string;
    device: BootedDevice;
    expectedCtrlProxyCtor: Function;
    expectedTapStrategyCtor: Function;
    expectedSystemConfigCtor: Function;
    expectedNotificationUICtor: Function;
  }

  const cases: ReadonlyArray<PlatformCase> = [
    {
      name: "android",
      device: androidDevice,
      expectedCtrlProxyCtor: AndroidCtrlProxyClient,
      expectedTapStrategyCtor: AndroidTapStrategy,
      expectedSystemConfigCtor: AndroidSystemConfigurationAdapter,
      expectedNotificationUICtor: AndroidNotificationUIDetector,
    },
    {
      name: "ios",
      device: iosDevice,
      expectedCtrlProxyCtor: IOSCtrlProxyClient,
      expectedTapStrategyCtor: IosTapStrategy,
      expectedSystemConfigCtor: IosSystemConfigurationAdapter,
      expectedNotificationUICtor: IosNotificationUIDetector,
    },
  ];

  for (const c of cases) {
    describe(`createPlatformClient (${c.name})`, () => {
      it("returns the platform-appropriate CtrlProxy client", () => {
        const client = createPlatformClient(c.device, buildOptions());
        expect(client.ctrlProxy).toBeInstanceOf(c.expectedCtrlProxyCtor);
      });

      it("returns the platform-appropriate TapStrategy", () => {
        const client = createPlatformClient(c.device, buildOptions());
        expect(client.tapStrategy).toBeInstanceOf(c.expectedTapStrategyCtor);
      });

      it("returns the platform-appropriate SystemConfigurationAdapter", () => {
        const client = createPlatformClient(c.device, buildOptions());
        expect(client.systemConfiguration).toBeInstanceOf(
          c.expectedSystemConfigCtor
        );
      });

      it("returns the platform-appropriate NotificationUIDetector", () => {
        const client = createPlatformClient(c.device, buildOptions());
        expect(client.notificationUI).toBeInstanceOf(
          c.expectedNotificationUICtor
        );
      });

      it("bundles the same device on the facade", () => {
        const client = createPlatformClient(c.device, buildOptions());
        expect(client.device).toBe(c.device);
        expect(client.notificationUI.device).toBe(c.device);
      });

      it("satisfies the PlatformClient interface", () => {
        const client: PlatformClient = createPlatformClient(
          c.device,
          buildOptions()
        );
        expect(client.device).toBeDefined();
        expect(client.ctrlProxy).toBeDefined();
        expect(typeof client.tapStrategy.isAccessibilityServiceEnabled).toBe(
          "function"
        );
        expect(typeof client.systemConfiguration.setLocale).toBe("function");
        expect(typeof client.notificationUI.isTrayOpen).toBe("function");
      });
    });
  }

  describe("createPlatformClient overrides", () => {
    it("uses the injected ctrlProxy without constructing a platform client", () => {
      const sentinel = { sentinel: true } as any;
      const client = createPlatformClient(androidDevice, {
        ...buildOptions(),
        ctrlProxy: sentinel,
      });
      expect(client.ctrlProxy).toBe(sentinel);
    });

    it("honors per-handle overrides for tapStrategy, systemConfiguration, and notificationUI", () => {
      const tapStrategy = new FakeTapStrategy();
      const systemConfiguration = new FakeSystemConfigurationAdapter();
      const notificationUI = new FakeNotificationUIDetector(androidDevice);

      const client = createPlatformClient(androidDevice, {
        ...buildOptions(),
        tapStrategy,
        systemConfiguration,
        notificationUI,
      });

      expect(client.tapStrategy).toBe(tapStrategy);
      expect(client.systemConfiguration).toBe(systemConfiguration);
      expect(client.notificationUI).toBe(notificationUI);
    });
  });

  describe("FakePlatformClient", () => {
    it("satisfies the PlatformClient interface", () => {
      const fake = new FakePlatformClient(androidDevice);
      const asFacade: PlatformClient = fake;
      expect(asFacade.device).toBe(androidDevice);
      expect(asFacade.tapStrategy).toBe(fake.tapStrategy);
      expect(asFacade.systemConfiguration).toBe(fake.systemConfiguration);
      expect(asFacade.notificationUI).toBe(fake.notificationUI);
    });

    it("forwards recording calls to the bundled sub-fakes", async () => {
      const fake = new FakePlatformClient(androidDevice);
      await fake.tapStrategy.isAccessibilityServiceEnabled();
      await fake.systemConfiguration.setTimeZone("UTC");
      fake.notificationUI.isTrayOpen(undefined);

      expect(fake.tapStrategy.wasMethodCalled("isAccessibilityServiceEnabled"))
        .toBe(true);
      expect(fake.systemConfiguration.wasMethodCalled("setTimeZone"))
        .toBe(true);
      expect(fake.notificationUI.wasMethodCalled("isTrayOpen")).toBe(true);
    });

    it("accepts injected sub-fakes through the overrides bag", () => {
      const tap = new FakePlatformClient().tapStrategy;
      tap.longPressDurationMs = 12345;
      const fake = new FakePlatformClient(iosDevice, { tapStrategy: tap });
      expect(fake.tapStrategy.longPressDurationMs).toBe(12345);
      expect(fake.device).toBe(iosDevice);
    });

    it("default ctrlProxy throws on access with a pointed message", () => {
      const fake = new FakePlatformClient(androidDevice);
      expect(() => (fake.ctrlProxy as any).getAccessibilityHierarchy())
        .toThrow(/FakePlatformClient\.ctrlProxy/);
    });
  });
});
