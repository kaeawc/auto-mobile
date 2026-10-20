import { HybridVideoCaptureBackend } from "../../src/features/video/HybridVideoCaptureBackend";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { runVideoCaptureBackendContract } from "./VideoCaptureBackendContract";

runVideoCaptureBackendContract("FakeVideoCaptureBackend", () => new FakeVideoCaptureBackend());

// The real routing class over per-platform children: the Android device in the contract is routed
// to the platform child (the ffmpeg-pipe opt-in env var is unset under test).
runVideoCaptureBackendContract(
  "HybridVideoCaptureBackend (scripted child backends)",
  () =>
    new HybridVideoCaptureBackend(
      new FakeVideoCaptureBackend(),
      new FakeVideoCaptureBackend(),
      new FakeVideoCaptureBackend(),
    ),
);
