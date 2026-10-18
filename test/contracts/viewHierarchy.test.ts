import { afterEach, beforeEach } from "bun:test";
import { ViewHierarchy } from "../../src/features/observe/ViewHierarchy";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeViewHierarchy } from "../fakes/FakeViewHierarchy";
import { installFakeCtrlProxyManagers } from "../helpers/hermeticDeviceTools";
import { runViewHierarchyContract } from "./ViewHierarchyContract";

let restoreDeviceToolProviders: () => void;
beforeEach(() => {
  restoreDeviceToolProviders = installFakeCtrlProxyManagers();
});
afterEach(() => {
  restoreDeviceToolProviders();
});

runViewHierarchyContract("ViewHierarchy", () => ({
  hierarchy: new ViewHierarchy(
    { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
    new FakeAdbClientFactory(),
    null,
  ),
}));

runViewHierarchyContract("FakeViewHierarchy", () => ({ hierarchy: new FakeViewHierarchy() }));
