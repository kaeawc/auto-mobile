package dev.jasonpearson.automobile.desktop.core.video

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield

/** In-memory [VideoStreamSource] for previews and tests. */
class FakeVideoStreamSource(options: Options = Options()) :
  FakeVideoStreamTelemetry(options.nowMs) {
  data class Options(
    val available: Boolean = true,
    val refuseWith: String? = null,
    val screenRecordingRequired: Boolean = false,
    val screenRecordingApprovalTarget: String = "AutoMobile",
    val nowMs: () -> Long = { 0L },
    /**
     * When true, [connect] stays in [VideoStreamState.Connecting] (never reaches Streaming) — for
     * exercising the first-frame-deadline watchdog.
     */
    val holdConnecting: Boolean = false,
    val connectThenRefuse: Boolean = false,
    val refusalScope: CoroutineScope? = null,
  )

  private val available = options.available
  private val refuseWith = options.refuseWith
  private var screenRecordingRequired = options.screenRecordingRequired
  private val screenRecordingApprovalTarget = options.screenRecordingApprovalTarget
  private val holdConnecting = options.holdConnecting
  private val connectThenRefuse = options.connectThenRefuse
  private val refusalScope = options.refusalScope

  private val _state = MutableStateFlow<VideoStreamState>(VideoStreamState.Idle)
  override val state: StateFlow<VideoStreamState> = _state.asStateFlow()

  private val _subscriptionKind = MutableStateFlow<VideoStreamSubscriptionKind?>(null)
  override val subscriptionKind: StateFlow<VideoStreamSubscriptionKind?> =
    _subscriptionKind.asStateFlow()
  private val _readOnly = MutableStateFlow(false)
  override val readOnly: StateFlow<Boolean> = _readOnly.asStateFlow()

  var connectedDeviceId: String? = null
    private set

  var connectCalls: Int = 0
    private set

  override fun isAvailable(): Boolean = available

  override fun connect(deviceId: String?) {
    _subscriptionKind.value = null
    _readOnly.value = false
    connectCalls++
    connectedDeviceId = deviceId
    if (connectThenRefuse && refuseWith != null) {
      _state.value = VideoStreamState.Connecting
      if (refusalScope != null) {
        refusalScope.launch {
          yield()
          _state.value = VideoStreamState.Unavailable(refuseWith)
        }
      } else {
        _state.value = VideoStreamState.Unavailable(refuseWith)
      }
      return
    }
    _state.value =
      when {
        !available -> VideoStreamState.Unavailable("Live mirroring is unavailable on this daemon")
        screenRecordingRequired ->
          VideoStreamState.PermissionRequired(
            VideoStreamPermission.ScreenRecordingNeedsApproval,
            screenRecordingApprovalTarget,
          )
        refuseWith != null -> VideoStreamState.Unavailable(refuseWith)
        holdConnecting -> VideoStreamState.Connecting
        else -> VideoStreamState.Streaming(1080, 2400)
      }
  }

  override fun disconnect() {
    connectedDeviceId = null
    _state.value = VideoStreamState.Idle
  }

  override fun dispose() {
    disconnect()
  }

  fun becomeDowngraded() {
    _subscriptionKind.value = VideoStreamSubscriptionKind.Viewer
    _readOnly.value = true
  }

  fun setSubscriptionKind(kind: VideoStreamSubscriptionKind?) {
    _subscriptionKind.value = kind
  }

  fun endWith(reason: VideoStreamEndReason) {
    _state.value = VideoStreamState.Ended(reason)
  }

  /** Simulates an unavailable relay after a stream has started. */
  fun becomeUnavailable(reason: String = "Live mirroring is unavailable on this daemon") {
    _state.value = VideoStreamState.Unavailable(reason)
  }

  /**
   * Forces the Streaming state directly, independent of [connect] (which a `refuseWith` fake keeps
   * routing to Unavailable) — used to stage a retained-frame-then-drop scenario.
   */
  fun becomeStreaming(width: Int = 1080, height: Int = 2400) {
    _state.value = VideoStreamState.Streaming(width, height)
  }

  /** Simulates granting the macOS permission after the Settings flow. */
  fun grantScreenRecording() {
    screenRecordingRequired = false
  }
}
