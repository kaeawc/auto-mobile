import { ViewHierarchy } from "../../src/features/observe/ViewHierarchy";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeViewHierarchy } from "../fakes/FakeViewHierarchy";
import { runViewHierarchyContract } from "./ViewHierarchyContract";

runViewHierarchyContract("ViewHierarchy", () => ({
  hierarchy: new ViewHierarchy(
    { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
    new FakeAdbClientFactory(),
    null,
  ),
}));

runViewHierarchyContract("FakeViewHierarchy", () => ({ hierarchy: new FakeViewHierarchy() }));
