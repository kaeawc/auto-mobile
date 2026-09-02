import { CountingIdGenerator, NodeIdGenerator } from "../../src/utils/IdGenerator";
import { CryptoRandom } from "../../src/utils/Random";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { SeededRandom } from "../fakes/SeededRandom";
import { FakeFileSystem } from "../fakes/FakeFileSystem";
import { FakeHostCommandExecutor } from "../fakes/FakeHostCommandExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { runHostCommandExecutorContract } from "./CommandExecutorContract";
import { runFileSystemContract } from "./FileSystemContract";
import { runIdGeneratorContract } from "./IdGeneratorContract";
import { runRandomContract } from "./RandomContract";
import { runTimerContract } from "./TimerContract";

runIdGeneratorContract("NodeIdGenerator", () => new NodeIdGenerator());
runIdGeneratorContract("CountingIdGenerator", () => new CountingIdGenerator());
runIdGeneratorContract("FakeIdGenerator", () => new FakeIdGenerator());

runRandomContract("CryptoRandom", () => new CryptoRandom());
runRandomContract("SeededRandom", () => new SeededRandom(42));

runTimerContract("FakeTimer auto-advance", () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return timer;
});
runTimerContract("FakeTimer manual advance", () => new FakeTimer(), {
  advance: async (timer, ms) => {
    (timer as FakeTimer).advanceTime(ms);
  },
});

runFileSystemContract("FakeFileSystem", () => new FakeFileSystem(), {
  root: "/fake-root",
});

runHostCommandExecutorContract("FakeHostCommandExecutor", {
  make: () => {
    const executor = new FakeHostCommandExecutor();
    executor.setDefaultResponse({
      stdout: "contract-output",
      stderr: "",
      toString() {
        return this.stdout;
      },
      trim() {
        return this.stdout.trim();
      },
      includes(searchString: string) {
        return this.stdout.includes(searchString);
      },
    });
    return executor;
  },
  file: "contract-command",
  args: [],
});
