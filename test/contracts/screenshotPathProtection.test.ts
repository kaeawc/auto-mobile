import { BoundedScreenshotPathProtection } from "../../src/features/observe/ScreenshotRetention";
import { FakeScreenshotPathProtection } from "../fakes/FakeScreenshotPathProtection";
import { runScreenshotPathProtectionContract } from "./ScreenshotPathProtectionContract";

runScreenshotPathProtectionContract(
  "BoundedScreenshotPathProtection",
  (timer) => new BoundedScreenshotPathProtection(timer),
);
runScreenshotPathProtectionContract(
  "FakeScreenshotPathProtection",
  (timer) => new FakeScreenshotPathProtection(timer),
);
