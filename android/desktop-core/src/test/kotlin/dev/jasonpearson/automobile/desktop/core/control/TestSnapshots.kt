package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.domain.CoordinateSpace
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSource

/** A plain, internally-consistent snapshot for control tests that do not exercise the policy. */
internal data class TestSnapshotSpec(
  val deviceId: String = "emulator-5554",
  val sequence: Long = 1L,
  val deviceWidth: Int = 1080,
  val deviceHeight: Int = 2340,
  val coordinateSpace: CoordinateSpace? = null,
  val nativeScale: Double? = if (coordinateSpace == CoordinateSpace.Pixels) 1.0 else null,
  val frameContext: String = "epoch:$sequence",
)

internal fun testSnapshot(spec: TestSnapshotSpec = TestSnapshotSpec()): DeviceFrameSnapshot =
  with(spec) {
    DeviceFrameSnapshot(
      deviceId = deviceId,
      sequence = sequence,
      capturedAtMs = 1_000L,
      source = DeviceFrameSource.Screenshot,
      frameWidth = deviceWidth,
      frameHeight = deviceHeight,
      deviceWidth = deviceWidth,
      deviceHeight = deviceHeight,
      screenshotData = null,
      hierarchy = null,
      coordinateSpace = coordinateSpace,
      captureSequence = sequence,
      frameContext = frameContext,
      screenshotSequence = sequence,
      hierarchySequence = sequence,
      liveFrameSequence = null,
      nativeScale = nativeScale,
    )
  }
