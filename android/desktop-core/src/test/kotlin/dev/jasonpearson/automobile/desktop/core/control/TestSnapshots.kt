package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.domain.CoordinateSpace
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSource

/** A plain, internally-consistent snapshot for control tests that do not exercise the policy. */
internal fun testSnapshot(
  deviceId: String = "emulator-5554",
  sequence: Long = 1L,
  deviceWidth: Int = 1080,
  deviceHeight: Int = 2340,
  coordinateSpace: CoordinateSpace? = null,
  frameContext: String = "epoch:$sequence",
): DeviceFrameSnapshot =
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
  )
