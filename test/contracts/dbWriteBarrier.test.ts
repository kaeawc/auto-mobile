import { InMemoryDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";
import { runDbWriteBarrierContract } from "./DbWriteBarrierContract";

runDbWriteBarrierContract("InMemoryDbWriteBarrier", () => {
  const timer = new FakeTimer();
  return { barrier: new InMemoryDbWriteBarrier(timer), advance: (ms) => timer.advanceTime(ms) };
});

runDbWriteBarrierContract("FakeDbWriteBarrier", () => {
  const timer = new FakeTimer();
  return { barrier: new FakeDbWriteBarrier(timer), advance: (ms) => timer.advanceTime(ms) };
});
