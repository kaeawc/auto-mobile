package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.LIVE_STALL_RECONNECT_MS
import dev.jasonpearson.automobile.desktop.core.LiveVideoFrameOptions
import dev.jasonpearson.automobile.desktop.core.platform.MacScreenRecordingSettingsLauncher
import dev.jasonpearson.automobile.desktop.core.platform.ScreenRecordingSettingsLauncher
import dev.jasonpearson.automobile.desktop.core.rememberLiveVideoFrame
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamClient
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamEndReason
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamQuality
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import dev.jasonpearson.automobile.desktop.core.video.isStreamAuthFailure
import kotlinx.coroutines.delay

/**
 * Live device mirror for a workspace pane's stream area: subscribes to the daemon's video-stream
 * relay for this pane's device and draws the newest decoded frame, aspect-fit. Until a frame
 * arrives (or when the relay is refused/unavailable) a one-line status hint renders instead, so a
 * daemon without the relay degrades to a quiet placeholder rather than an error wall.
 *
 * One source lives per pane, keyed by deviceId: [rememberLiveVideoFrame] connects it on entry and
 * disposes it when the pane leaves the composition, so closing a column or flipping it to Inspect
 * mode tears the relay subscription down.
 *
 * [sessionUuidProvider] authenticates the subscribe against the stream-socket session guard
 * (#4751): the host supplies a provider from its `DesktopDaemonSession` (#4977). The workspace
 * session binds only the focused device, so this pane's subscribe passes either as the session's
 * own device or — for every other observed device — via the auth's unowned-device branch. When the
 * provider yields null (no session, or a non-Unix daemon) the subscribe is refused and the pane
 * shows the reason; the operator escape hatch remains `AUTOMOBILE_DAEMON_STREAM_AUTH=0`.
 *
 * [sourceFactory] is hoisted so tests inject a fake instead of opening a socket.
 */
// Frame-rate + quality hints the pane sends the relay on subscribe.
//
// An actively-CONTROLLED pane is one the user is driving, so it streams at [CONTROL_PANE_FPS] with
// the High preset for the tightest, sharpest tap→visible-response. A display-only mirror instead
// uses the cheap farm defaults — the Low preset (Android: long side ~540 + ~2 Mbps; a pane can't
// show more pixels than that anyway, and decode cost scales with pixel count) and [MIRROR_PANE_FPS]
// — which is what keeps dozens of concurrent farm panes affordable (#5217). Frames are decoupled
// from input dispatch (issue #3348), so the mirror rate only bounds how quickly a tap's visual
// result appears, never the tap itself. The relay validates the hint in [5, 60]; the first
// subscriber's hint fixes the shared per-device encode.
private const val CONTROL_PANE_FPS = 30
private const val MIRROR_PANE_FPS = 10

/**
 * How long the armed control surface survives on retained pixels while the stream is between
 * Streaming states (re-subscribe, brief drop). Long enough to cover a quality-step reconnect, short
 * enough that a genuinely dead relay disarms before the on-screen UI can meaningfully drift from
 * the device.
 */
private const val ARMED_FRAME_RETENTION_MS = 3_000L

/** Test tag on the armed interactive-video surface, so tests can pin which branch rendered. */
internal const val DEVICE_CONTROL_SURFACE_TEST_TAG = "device-control-surface"

data class DeviceStreamOptions(
  val column: DeviceColumn,
  val sessionUuidProvider: () -> String? = { null },
  val enableDeviceControl: Boolean = false,
  val control: WorkspaceDeviceControlState? = null,
  val settings: SettingsProvider? = null,
  val streamingEnabled: Boolean = true,
  val sourceFactory: (deviceId: String, quality: VideoStreamQuality) -> VideoStreamSource =
    { deviceId, quality ->
      VideoStreamClient(
        VideoStreamClient.Options(
          quality = quality,
          fps = if (enableDeviceControl) CONTROL_PANE_FPS else MIRROR_PANE_FPS,
          sessionUuidProvider = sessionUuidProvider,
        ),
      )
    },
  val screenRecordingSettingsLauncher: ScreenRecordingSettingsLauncher =
    MacScreenRecordingSettingsLauncher(),
  val armedFrameGraceWait: suspend () -> Unit = { delay(ARMED_FRAME_RETENTION_MS) },
)

@Composable
fun DeviceStreamView(options: DeviceStreamOptions) {
  val column = options.column

  val enableDeviceControl = options.enableDeviceControl

  val streamingEnabled = options.streamingEnabled
  val sourceFactory = options.sourceFactory

  // The pane's fixed per-mode preset when there's no controller: an armed (user-driven) pane wants
  // the sharpest High stream; unfocused farm mirrors stay on the cheap Low preset.
  val defaultQuality = if (enableDeviceControl) VideoStreamQuality.High else VideoStreamQuality.Low
  val paneFps = if (enableDeviceControl) CONTROL_PANE_FPS else MIRROR_PANE_FPS

  // Quality controls live only on the actively-driven (focused/armed) pane, never on the farm's
  // display-only mirrors: those stay the cheap fixed Low preset with no overlay, which is what
  // keeps
  // dozens of concurrent panes affordable (#5217) and uncluttered. With settings wired the focused
  // pane's per-device controller measures the live rate and (when auto-adjust is on) steps the
  // preset down on a sustained drop / back up once healthy. Only a MANUAL pick persists (the
  // seed for the next launch); automatic steps re-subscribe but are not written to the settings
  // file. Keyed on deviceId so switching devices starts fresh.
  val qualityController = rememberPaneQuality(options, defaultQuality, paneFps)
  val currentQuality =
    if (qualityController != null) qualityController.quality.collectAsState().value
    else defaultQuality
  // The live video mirror always streams — it's what the user watches in both modes. Farm panes
  // auto-reconnect so a dropped relay heals instead of staying "stopped" until the pane is torn
  // down. Keyed on deviceId AND the current preset: a user-driven quality change (or an auto-adjust
  // step) re-subscribes with the new hint. That takes effect for a sole subscriber / the next fresh
  // subscribe; while a per-device capture is SHARED the daemon fixes its encode from the FIRST
  // subscriber's hint and ignores a re-subscriber's differing one (VideoStreamSocketServer.attach),
  // so truly reconfiguring a live shared capture needs server-side work (follow-up). When
  // [settings]
  // is null the preset is constant, so this keys on deviceId only — unchanged from before.
  // Keyed on deviceId, the current preset, AND paneFps: focus changes paneFps (10↔30) independently
  // of the preset, so without paneFps a pane that gains/loses focus without a preset change would
  // keep streaming at the old rate (a focused pane stuck at the farm 10fps, or an unfocused pane
  // still consuming 30fps). Re-subscribing on the change applies for a sole subscriber / the next
  // subscribe; a live shared capture keeps the first subscriber's encode (server follow-up).
  val source =
    remember(column.deviceId, currentQuality, paneFps) {
      sourceFactory(column.deviceId, currentQuality)
    }
  // The relay's own heartbeat (issue #7549) makes the Streaming-stall watchdog safe on any backend,
  // including iOS's idle-buffer-dropping capture and the Android screenrecord fallback — a healthy
  // static screen still advances lastActivityMs every heartbeat, so it is never mistaken for a
  // stall. Only a daemon too old to advertise heartbeatMs falls back to the pre-#7549 heuristic
  // (enabled for Android only, since only its persistent encoder emitted idle frames of its own).
  val heartbeatMs by source.heartbeatMs.collectAsState()
  val liveFrame =
    rememberLiveVideoFrame(
      LiveVideoFrameOptions(
        source,
        column.deviceId,
        autoReconnect = true,
        streamingEnabled = streamingEnabled,
        stallReconnectMs = stallReconnectPolicy(column.platform, heartbeatMs),
      ),
    )
  // Retain the newest frame ACROSS source swaps, keyed on the device. rememberLiveVideoFrame
  // retains frames across relay drops WITHIN one source, but arming the pane (fps 10→30), a manual
  // preset pick, or an auto-adjust step recreates the source — resetting that per-source state to
  // null and flashing "Connecting to live mirror…" mid-interaction. The mirror keeps rendering this
  // retained frame until the new subscription decodes its first frame, so a re-subscribe is
  // seamless. Keyed on deviceId so one device never shows another device's last frame; control
  // arming still requires a CURRENT frame + Streaming state (below), so stale pixels are never
  // clickable.
  val retainedFrame = rememberRetainedStreamFrame(column.deviceId, liveFrame)
  val state by source.state.collectAsState()
  val readOnly by source.readOnly.collectAsState()
  val newestFrame = liveFrame ?: retainedFrame
  // Grace window for CONTROL across transient non-Streaming windows (a quality-step re-subscribe,
  // a brief relay drop before auto-reconnect): the clock starts when the stream LEAVES Streaming
  // — not from the last frame's age. Aging frames would pre-expire on a healthy static iOS screen
  // (its capture emits no frames while idle), so the very first source swap would disarm
  // immediately and recreate the Tap Targets flicker this gate exists to prevent. While Streaming
  // the window is continuously reset; once Streaming is lost the armed surface may keep using the
  // newest frame until [armedFrameGraceWait] completes, then control disarms — preserving "stale
  // pixels are
  // never clickable" (#5255). Keyed on [source] as well: a swap while the OLD source was already
  // mid-grace (same non-Streaming boolean, so no transition) restarts the window for the fresh
  // connection attempt rather than letting the old source's clock expire it. The restart cannot
  // re-arm already-expired pixels — the effect body only CLEARS the flag under Streaming, so an
  // expired verdict carries across the swap until the new source actually streams.
  val armedFrame = rememberArmedStreamFrame(options, source, state, newestFrame)
  val droppedFrames by source.droppedFrames.collectAsState(initial = null)
  // Perf span T3: mark each newly rendered video frame so the tracer can time the first frame after
  // a tap (the visual-response latency). Cheap no-op unless a dispatched tap is pending. The same
  // frame arrival feeds the quality controller so its live-rate estimate (and any auto-adjust) is
  // driven by exactly the frames the pane renders.
  ObserveStreamFrames(options, liveFrame, qualityController, droppedFrames)
  DeviceStreamSurface(
    options,
    StreamSurfaceState(
      source,
      state,
      newestFrame,
      armedFrame,
      readOnly,
      qualityController,
      currentQuality,
    ),
  )
}

internal fun stallReconnectPolicy(platform: Platform, heartbeatMs: Long?): Long? =
  if (heartbeatMs != null || platform == Platform.Android) LIVE_STALL_RECONNECT_MS else null

internal fun retainedStreamStatus(hasFrame: Boolean, state: VideoStreamState): String? =
  if (hasFrame && (state is VideoStreamState.Unavailable || state is VideoStreamState.Ended))
    streamStatusHint(state)
  else null

internal fun controlArmed(
  enableDeviceControl: Boolean,
  hasControl: Boolean,
  hasSnapshot: Boolean,
  hasFrame: Boolean,
  readOnly: Boolean,
): Boolean = enableDeviceControl && hasControl && hasSnapshot && hasFrame && !readOnly

/**
 * The pane's video surface: permission gate, armed interactive video, or plain mirror/hint. Split
 * out of [DeviceStreamView] so the quality overlay can compose over it without duplicating the
 * branch selection.
 */

/**
 * One-line hint for a stream that has no frame on screen. `internal` (not `private`) so the
 * same-module pure test can pin the wording without composing the view.
 */
internal fun streamStatusHint(state: VideoStreamState): String =
  when (state) {
    is VideoStreamState.Idle -> "Live mirror idle"
    is VideoStreamState.Connecting -> "Connecting to live mirror…"
    // Streaming with no frame yet: the subscribe was accepted but nothing has decoded.
    is VideoStreamState.Streaming -> "Waiting for the first frame…"
    is VideoStreamState.PermissionRequired -> "Screen Recording needs approval"
    is VideoStreamState.Ended -> "Live mirroring stopped: ${streamEndReasonText(state.reason)}"
    is VideoStreamState.Unavailable ->
      when (state.cause) {
        VideoStreamState.UnavailableCause.NO_RELAY ->
          "Live mirroring unavailable\nThis daemon has no video-stream relay. Update or restart the daemon to enable live mirroring."
        VideoStreamState.UnavailableCause.REFUSED ->
          if (isStreamAuthFailure(state.reason)) {
            "Live mirroring refused\n${state.reason}\nCheck the daemon stream-auth setting (AUTOMOBILE_DAEMON_STREAM_AUTH)."
          } else {
            "Live mirroring refused\n${state.reason}"
          }
        VideoStreamState.UnavailableCause.OTHER -> state.reason
      }
  }

internal fun streamEndReasonText(reason: VideoStreamEndReason): String =
  when (reason) {
    VideoStreamEndReason.DeviceRemoved -> "The device was removed."
    VideoStreamEndReason.IdentityQuarantined -> "The device's identity changed."
    VideoStreamEndReason.DaemonShutdown -> "The AutoMobile daemon shut down."
    VideoStreamEndReason.SessionEnded -> "This session ended."
    VideoStreamEndReason.DeviceRestored ->
      "The device was restored from a snapshot. Reconnect to continue."
  }
