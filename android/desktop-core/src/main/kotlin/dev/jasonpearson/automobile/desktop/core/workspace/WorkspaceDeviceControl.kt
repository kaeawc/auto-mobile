package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.control.DeviceControlSession
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.layout.LayoutInspectorState
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot

private val LOG = LoggerFactory.getLogger("WorkspaceDeviceControl")

// Ongoing paired-capture cadence requested while a pane's control is armed.
//
// This used to be ~1s: the OLD (frame-identity) control path needed a fresh paired
// screenshot+hierarchy right after each input to keep the tap coordinates coherent. The decoupled
// [VideoInputDispatcher] removed that — a tap is frame-identity-free and the device geometry it
// maps
// through is retained indefinitely — so fast ongoing observation is no longer needed to interact.
// Arming itself is unaffected: the daemon pushes an INITIAL frame on subscribe
// (`pushInitialObservationFramesForSubscriber`), so the pane still becomes clickable immediately.
//
// Keeping the fast cadence was costly: every tick pulls a full screenshot (tens of KB) and a
// hierarchy over the same ADB pipe the H.264 video shares. On a USB-attached physical device that
// steady traffic — worst during a high-motion moment like swipe-up-to-home, when the hierarchy also
// churns — starves the video and shows up as playback lag. A much slower cadence frees that
// bandwidth for the video; the only cost is that a device rotation (also attested by the video
// stream) and any open Layout facet refresh less often, which is a fine trade for a control pane.
private const val CONTROL_SCREENSHOT_INTERVAL_MS = 5_000L
private const val CONTROL_HIERARCHY_INTERVAL_MS = 5_000L

internal fun createWorkspaceControlObservationClient(sessionUuidProvider: (() -> String?)? = null) =
  ObservationStreamClient(sessionUuidProvider = sessionUuidProvider)

/**
 * Per-column device-control holder for the workspace video pane.
 *
 * **Input is deliberately DECOUPLED from the video frame.** The observation stream (an
 * [ObservationStreamClient] feeding a [LayoutInspectorState]) is used ONLY to learn the device
 * *geometry* — width, height, rotation — which a click is mapped through. That geometry is a stable
 * device property, so the last snapshot is retained INDEFINITELY: the pane stays armed and
 * clickable forever once a first snapshot arrives, instead of disarming a few seconds after each
 * tap when the daemon dedupes its (unchanged) hierarchy pushes.
 *
 * The tap itself does NOT flow through [DeviceControlSession]. That session exists to keep the
 * *clicked observation pixels* coherent with the mapping — capture-identity pairing,
 * coordinate-space tracking, and a `frameContext` tag the daemon can reject as stale. Here the user
 * clicks the live **video**, not the observation screenshot, so none of that applies; tagging a
 * video tap with an aging observation `frameContext` is precisely what froze the pane on a static
 * screen. Taps go straight to [VideoInputDispatcher], which sends `input/tap` with no
 * `frameContext` — the daemon never rejects it as stale, and the pane never wedges.
 *
 * [interactionSnapshot] is what a click maps through; [renderSnapshot] supplies the device
 * dimensions the mapping fits against (they are the same retained snapshot here). [dispatcher]
 * sends the mapped input.
 */
class WorkspaceDeviceControlState(
  val dispatcher: VideoInputDispatcher,
  val interactionSnapshot: DeviceFrameSnapshot?,
  val renderSnapshot: DeviceFrameSnapshot?,
  val tapError: String?,
  /** Records tap→map→dispatch→ack→first-frame latency so we can tune interaction responsiveness. */
  val tracer: InteractionLatencyTracer,
)

/**
 * Builds the per-column control holder. [enabled] false leaves it inert (no observation stream, no
 * snapshot) so the pane degrades to the plain video mirror. [streamFactory] is hoisted so tests
 * inject a fake instead of opening a socket. [clientProvider] must mint a FRESH [AutoMobileClient]
 * per call (the session closes each one after dispatch) — never the shared long-lived client.
 */
@Composable
fun rememberWorkspaceDeviceControl(
  options: WorkspaceDeviceControlOptions,
): WorkspaceDeviceControlState {
  return with(options) {
    val scope = rememberCoroutineScope()
    val layoutState = remember(column.deviceId) { LayoutInspectorState() }
    var tapError by remember(column.deviceId) { mutableStateOf<String?>(null) }
    val tracer = remember(column.deviceId) { InteractionLatencyTracer() }

    // The provider swaps behind the long-lived holder (a daemon reconnect must not strand a queued
    // input on a superseded client); it is read at dispatch time so the newest client is always
    // used.

    // The decoupled input path: a click on the video pane maps through the retained geometry
    // snapshot
    // and dispatches straight here, frame-identity-free (see [VideoInputDispatcher]). This is what
    // makes input immune to the observation stream's dedup/staleness — the wedge the session
    // caused.
    val dispatcher = rememberWorkspaceInput(options, scope, tracer)

    // When the pane deactivates (loses focus, or the daemon can't serve input), retire the
    // dispatcher:
    // drop any queued/buffered input so it can't later fire at the no-longer-focused device, and
    // free
    // its warm dispatch thread instead of holding one per farm pane. Re-enabling re-activates it on
    // the next input. `enabled` false on first composition is a no-op (nothing queued, no thread
    // yet).
    LaunchedEffect(dispatcher, enabled) { if (!enabled) dispatcher.reset() }

    // The session is kept ONLY to turn the observation stream into a geometry snapshot
    // ([session.renderSnapshot]); it never dispatches from the video pane, so its client/error
    // hooks
    // are inert. reset() on a provider swap keeps its snapshot state coherent across reconnects.
    val session = rememberWorkspaceGeometrySession(options, scope) { tapError = it }
    LaunchedEffect(clientProvider) { session.reset() }

    val sessionUuid = sessionUuidProvider?.invoke()
    val stream =
      key(sessionUuidProvider, sessionUuid) {
        if (enabled && (sessionUuidProvider == null || sessionUuid != null))
          rememberReconnectingObservationStream(
            dev.jasonpearson.automobile.desktop.core.workspace.ReconnectingObservationOptions(
              deviceId = column.deviceId,
              streamFactory = streamFactory,
            ),
          )
        else null
      }

    // Request a fast paired capture cadence while control is armed. The daemon's default is too
    // slow
    // (~3s screenshots), so after a tap the retained snapshot ages out before a superseding pair
    // arrives and control disarms — "one click works, then nothing". Mirrors the Live Layout
    // cadence;
    // setCadence is re-applied across reconnects by the client, and is a no-op when unchanged.
    LaunchedEffect(stream, enabled) {
      stream?.setCadence(
        screenshotIntervalMs = if (enabled) CONTROL_SCREENSHOT_INTERVAL_MS else null,
        hierarchyIntervalMs = if (enabled) CONTROL_HIERARCHY_INTERVAL_MS else null,
      )
    }

    WorkspaceHierarchyCollector(options, stream, layoutState, session)

    WorkspaceScreenshotCollector(options, stream, layoutState, session)

    val geometry = rememberWorkspaceGeometry(options, layoutState, session)

    // Diagnostic: log arm/disarm transitions so a wedge is visible in the daemon-run log.
    val armed = geometry != null
    LaunchedEffect(column.deviceId, armed) {
      LOG.info("device control ${if (armed) "ARMED" else "disarmed"} for ${column.deviceId}")
    }

    WorkspaceDeviceControlState(
      dispatcher = dispatcher,
      interactionSnapshot = geometry,
      renderSnapshot = geometry,
      tapError = tapError,
      tracer = tracer,
    )
  }
}
