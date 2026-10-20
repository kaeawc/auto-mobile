package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.video.LiveVideoFrame
import dev.jasonpearson.automobile.desktop.core.video.QualityController
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamQuality
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState

@Composable
internal fun rememberPaneQuality(
  options: DeviceStreamOptions,
  defaultQuality: VideoStreamQuality,
  paneFps: Int,
): QualityController? {
  val enableDeviceControl = options.enableDeviceControl
  val settings = options.settings
  val column = options.column
  return if (enableDeviceControl) {
    settings?.let { s ->
      remember(column.deviceId) {
        QualityController(
          dev.jasonpearson.automobile.desktop.core.video.QualityControllerOptions(
            initialQuality = VideoStreamQuality.fromWire(s.streamQualityPreset) ?: defaultQuality,
            targetFps = paneFps,
            autoAdjustEnabled = s.streamQualityAutoAdjust,
            onManualSelection = { s.streamQualityPreset = it.wire },
          ),
        )
      }
    }
  } else {
    null
  }
}

@Composable
internal fun rememberRetainedStreamFrame(
  deviceId: String,
  liveFrame: LiveVideoFrame?,
): LiveVideoFrame? {
  var retainedFrame by remember(deviceId) { mutableStateOf<LiveVideoFrame?>(null) }
  LaunchedEffect(liveFrame) {
    if (liveFrame != null) {
      retainedFrame = liveFrame
    }
  }

  return retainedFrame
}

@Composable
internal fun rememberArmedStreamFrame(
  options: DeviceStreamOptions,
  source: VideoStreamSource,
  state: VideoStreamState,
  newestFrame: LiveVideoFrame?,
): LiveVideoFrame? {
  val column = options.column
  val armedFrameGraceWait = options.armedFrameGraceWait
  var armedGraceExpired by remember(column.deviceId) { mutableStateOf(false) }
  val streamingNow = state is VideoStreamState.Streaming
  LaunchedEffect(source, streamingNow) {
    if (streamingNow) {
      armedGraceExpired = false
    } else {
      armedFrameGraceWait()
      armedGraceExpired = true
    }
  }
  return if (streamingNow || !armedGraceExpired) newestFrame else null
}

@Composable
internal fun ObserveStreamFrames(
  options: DeviceStreamOptions,
  liveFrame: LiveVideoFrame?,
  qualityController: QualityController?,
  droppedFrames: Long?,
) {
  val control = options.control
  val column = options.column
  LaunchedEffect(liveFrame?.sequence) {
    if (liveFrame != null) {
      control?.tracer?.videoFrameRendered(column.deviceId)
      qualityController?.onFrame(liveFrame.receivedAtMs)
    }
  }
  LaunchedEffect(droppedFrames) {
    droppedFrames?.let { qualityController?.onDroppedFrames(it) }
  }
}
