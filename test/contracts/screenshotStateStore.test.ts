import { InMemoryScreenshotStateStore } from "../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { FakeScreenshotStateStore } from "../fakes/FakeScreenshotStateStore";
import { runScreenshotStateStoreContract } from "./ScreenshotStateStoreContract";

runScreenshotStateStoreContract(
  "FakeScreenshotStateStore",
  (timer) => new FakeScreenshotStateStore(timer),
);
runScreenshotStateStoreContract(
  "InMemoryScreenshotStateStore",
  (timer) => new InMemoryScreenshotStateStore(timer),
);
