package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSource

/** A plain, internally-consistent snapshot for control tests that do not exercise the policy. */
internal fun testSnapshot(
  deviceId: String = "emulator-5554",
  sequence: Long = 1L,
  deviceWidth: Int = 1080,
  deviceHeight: Int = 2340,
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
    captureSequence = sequence,
    screenshotSequence = sequence,
    hierarchySequence = sequence,
    liveFrameSequence = null,
  )
