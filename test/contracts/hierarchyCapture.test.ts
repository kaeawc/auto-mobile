import {
  DefaultHierarchyCapture,
  type HierarchyCaptureReader,
} from "../../src/features/observe/HierarchyCapture";
import type { ViewHierarchyResult } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeHierarchyCapture } from "../fakes/FakeHierarchyCapture";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  runHierarchyCaptureContract,
  type ScriptedHierarchyCapture,
} from "./HierarchyCaptureContract";

const HOST_NOW = 7_000;

function real(): ScriptedHierarchyCapture {
  let current: ViewHierarchyResult = { hierarchy: {} };
  const reader: HierarchyCaptureReader = {
    readCached: async () => current,
    readFresh: async () => current,
    readSettled: async () => current,
    projectVisible: (hierarchy) => ({ ...hierarchy }),
  };
  const timer = new FakeTimer();
  timer.setCurrentTime(HOST_NOW);
  return {
    capture: new DefaultHierarchyCapture("android", reader, timer, new CountingIdGenerator()),
    script: (hierarchy) => {
      current = hierarchy;
    },
    hostNow: HOST_NOW,
  };
}

function fake(): ScriptedHierarchyCapture {
  let current: ViewHierarchyResult = { hierarchy: {} };
  const timer = new FakeTimer();
  timer.setCurrentTime(HOST_NOW);
  return {
    capture: new FakeHierarchyCapture(() => current, "android", timer, new CountingIdGenerator()),
    script: (hierarchy) => {
      current = hierarchy;
    },
    hostNow: HOST_NOW,
  };
}

runHierarchyCaptureContract("DefaultHierarchyCapture", real);
runHierarchyCaptureContract("FakeHierarchyCapture", fake);
