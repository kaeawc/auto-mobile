package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.shell.VerticalSplitOptions
import dev.jasonpearson.automobile.desktop.core.shell.VerticalSplitPane
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

@Composable
internal fun DeviceColumnView(
  column: DeviceColumn,
  onAction: (WorkspaceAction) -> Unit,
  modifier: Modifier,
  options: DeviceColumnContent,
) {
  return with(options) {
    Column(
      modifier =
        modifier
          // Click anywhere in an UNFOCUSED pane to make it the focused (and thus interactive)
          // device.
          // Control is focus-gated — only the focused pane arms, streams High-fps, and takes
          // keyboard
          // focus — so without a way to move focus by clicking, every non-focused video pane would
          // be
          // a dead mirror (the command palette was the only focus setter). This is a two-step
          // interaction by design: an unfocused pane renders the inert video mirror, so this
          // focusing
          // click only SWITCHES focus (it cannot actuate a device tap — the DeviceScreenView tap
          // surface mounts once the pane is focused); the next click drives the device. Observed on
          // the INITIAL pass and never consumed, so it doesn't swallow the pane's always-mounted
          // controls (the command bar's Screenshot/nav buttons still fire on that same click).
          // Gated
          // on !focused so clicking the already-focused pane emits nothing.
          .focusDeviceColumn(column, focused, onAction),
    ) {
      DeviceColumnHeader(column, displayName, onAction)
      val tool = column.activeTool
      VerticalSplitPane(
        options =
          VerticalSplitOptions(
            showSecond = tool != null,
            firstPaneFraction = firstPaneFraction(column),
            minFirstDp = 48.dp,
            minSecondDp = 48.dp,
            onFractionChanged = {
              onAction(WorkspaceAction.SetFirstPaneFraction(column.deviceId, it))
            },
          ),
        first = {
          PaneMainContent(
            column = column,
            onAction = onAction,
            modifier = Modifier.fillMaxSize(),
            options =
              PaneContent(
                inspectContent = inspectContent,
                streamContent = streamContent,
                observationStreamFactory = observationStreamFactory,
                screenshotSaver = screenshotSaver,
                externalCaptureRequest = externalCaptureRequest,
              ),
          )
        },
        second = {
          if (tool != null) {
            DockedFacet(
              column = column,
              tool = tool,
              onAction = onAction,
              modifier = Modifier.fillMaxSize(),
              options =
                DockedFacetContent(
                  facetContent = facetContent,
                  canDiff = canDiff,
                ),
            )
          }
        },
        modifier = Modifier.weight(1f),
      )
    }
  }
}

/**
 * The pane's primary content above any docked facet. In [InteractionMode.Input] this is the device
 * [StreamArea]; in [InteractionMode.Inspect] the stream is replaced by [inspectContent] (the
 * per-device Layout inspector), so the wireframe's 🔍 toggle gains behavior without adding a Tool.
 */
@Composable
internal fun PaneMainContent(
  column: DeviceColumn,
  onAction: (WorkspaceAction) -> Unit,
  modifier: Modifier,
  options: PaneContent,
) {
  return with(options) {

    // Keep the last consumed request while Inspect replaces the stream subtree. A request issued
    // there remains pending until the user returns to Input.
    var handledCapture by remember(column.deviceId) { mutableStateOf(externalCaptureRequest) }
    if (column.mode == InteractionMode.Inspect) {
      Box(modifier.fillMaxWidth()) { inspectContent(column) }
    } else {
      StreamArea(
        column = column,
        onAction = onAction,
        modifier = modifier,
        options =
          StreamContent(
            streamContent = streamContent,
            observationStreamFactory = observationStreamFactory,
            screenshotSaver = screenshotSaver,
            externalCaptureRequest = externalCaptureRequest,
            handledCapture = handledCapture,
            onHandledCapture = { handledCapture = it },
          ),
      )
    }
  }
}

/**
 * The pane's device stream area: the hoisted [streamContent] body (the host's live
 * [DeviceStreamView], or the placeholder default) with the emulator controls floating on it. The
 * Screenshot control captures the current frame off the observation stream and writes it to disk
 * via [screenshotSaver] — the pane already shows the device live, so Screenshot persists a still
 * rather than previewing one (#4694 AC3) — then flashes a transient "saved to …" confirmation.
 */
@Composable
internal fun StreamArea(
  column: DeviceColumn,
  onAction: (WorkspaceAction) -> Unit,
  modifier: Modifier,
  options: StreamContent,
) {
  val memory = rememberStreamCaptureMemory(column)
  with(memory) {
    return with(options) {

      // Result of the latest capture + a monotonically increasing request token. Keyed on deviceId
      // so
      // a
      // pane reused for a different device (panes are keyed by id, so this is defensive) starts
      // clean.

      LaunchedEffect(column.deviceId, externalCaptureRequest) {
        if (
          externalCaptureRequest != handledCapture &&
            externalCaptureRequest?.first == column.deviceId
        ) {
          captureRequest++
        }
        onHandledCapture(externalCaptureRequest)
      }

      // Each Screenshot tap bumps captureRequest, re-running this effect: open a fresh per-device
      // stream,
      // ask for an observation, take the first screenshot frame the subscription delivers, write
      // its
      // PNG
      // bytes to disk, and report where. Bounded by a timeout so a gone device can't hang the
      // coroutine,
      // and the stream is always disposed — including on cancellation when the pane closes or a
      // newer
      // tap
      // supersedes it.
      CaptureScreenshot(memory, column)

      // Auto-dismiss the confirmation after a short while.
      LaunchedEffect(savedNotice) {
        if (savedNotice != null) {
          delay(SCREENSHOT_NOTICE_MS)
          savedNotice = null
        }
      }

      Box(
        modifier = modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
      ) {
        streamContent(column)
        DeviceCommandBar(
          column = column,
          onAction = onAction,
          onCaptureScreenshot = { captureRequest++ },
          modifier = Modifier.align(Alignment.CenterEnd).padding(6.dp),
        )
        val notice = savedNotice
        if (notice != null) {
          Text(
            notice,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier =
              Modifier.align(Alignment.BottomCenter)
                .padding(6.dp)
                .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(4.dp))
                .padding(horizontal = 6.dp, vertical = 3.dp)
                .semantics { contentDescription = "Screenshot status ${column.name}" },
          )
        }
      }
    }
  }
}

/**
 * The docked facet (tool window) for a pane's active [tool]: a header with the tool icon + label
 * and a ✕ that deselects the tool, over a body supplied by [facetContent]. The body is hoisted so
 * the host can drop in real per-device dashboards; the default is [WorkspaceFacetPlaceholder].
 */
@Composable
internal fun DockedFacet(
  column: DeviceColumn,
  tool: Tool,
  onAction: (WorkspaceAction) -> Unit,
  modifier: Modifier,
  options: DockedFacetContent,
) {
  return with(options) {
    Column(modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)) {
      Row(
        modifier = Modifier.fillMaxWidth().height(30.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(tool.icon)
        Spacer(Modifier.width(6.dp))
        // Weighted + ellipsized so a long label on a narrow pane yields space to the trailing
        // controls
        // instead of pushing them off-screen.
        Text(
          tool.label,
          style = MaterialTheme.typography.labelLarge,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
          modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(6.dp))
        // ⧉ Diff opens the same tool on the other observed devices; only meaningful with >1 device.
        if (canDiff) {
          Glyph(
            text = "⧉",
            description = "Open ${tool.label} on all devices",
            active = false,
            onClick = { onAction(WorkspaceAction.DiffTool(tool)) },
          )
          Spacer(Modifier.width(6.dp))
        }
        Glyph(
          text = "✕",
          description = "Close ${tool.label} facet on ${column.name}",
          active = false,
          onClick = { onAction(WorkspaceAction.SelectTool(column.deviceId, null)) },
        )
      }
      Box(Modifier.weight(1f).fillMaxWidth()) { facetContent(column, tool) }
    }
  }
}

/**
 * Default stream-area body: the inert pre-live placeholder. Hosts swap in [DeviceStreamView] via
 * [WorkspaceShell]'s `streamContent` slot; tests and previews keep this so composing the shell
 * never opens a relay socket.
 */
@Composable
fun WorkspaceStreamPlaceholder() {
  Text("stream", color = MaterialTheme.colorScheme.outline)
}

/**
 * Default docked-facet body: a centered "coming soon" note for a tool with no wired dashboard.
 * Public so a host that wires real content for only some tools can reuse it as the fallback for the
 * rest (see [WorkspaceShell]'s `facetContent`).
 */
@Composable
fun WorkspaceFacetPlaceholder(tool: Tool) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Text("${tool.label} — coming soon", color = MaterialTheme.colorScheme.outline)
  }
}

@Composable
internal fun Modifier.focusDeviceColumn(
  column: DeviceColumn,
  focused: Boolean,
  onAction: (WorkspaceAction) -> Unit,
): Modifier =
  this.pointerInput(column.deviceId, focused) {
      if (!focused) {
        awaitEachGesture {
          awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
          onAction(WorkspaceAction.FocusDevice(column.deviceId))
        }
      }
    }
    .border(
      width = if (focused) 2.dp else 1.dp,
      color = if (focused) Accent else MaterialTheme.colorScheme.outlineVariant,
    )

@Composable
internal fun StreamContent.CaptureScreenshot(memory: StreamCaptureMemory, column: DeviceColumn) {
  with(memory) {
    LaunchedEffect(column.deviceId, captureRequest) {
      if (captureRequest == 0) return@LaunchedEffect
      val stream = observationStreamFactory(column.deviceId)
      try {
        val base64 =
          withContext(ioDispatcher) {
            // Connect/subscribe are blocking socket writes — keep them off the UI thread.
            stream.connect(
              column.deviceId,
              deviceSessionUuid = column.deviceSessionUuid,
            )
            stream.requestObservation(column.deviceId)
            withTimeoutOrNull(SCREENSHOT_CAPTURE_TIMEOUT_MS) {
              stream.screenshotUpdates
                .first { !it.screenshotBase64.isNullOrEmpty() }
                .screenshotBase64
            }
          }
        savedNotice =
          if (base64 != null) {
            val path =
              withContext(ioDispatcher) {
                screenshotSaver.save(column.name, Base64.getDecoder().decode(base64))
              }
            "Saved $path"
          } else {
            LOG.warn("Screenshot capture timed out for ${column.deviceId}")
            "Screenshot timed out"
          }
      } catch (cancellation: CancellationException) {
        throw cancellation
      } catch (error: java.io.IOException) {
        LOG.warn("Screenshot save failed for ${column.deviceId}: ${error.message}", error)
        savedNotice = "Screenshot failed"
      } catch (error: dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException) {
        LOG.warn("Screenshot save failed for ${column.deviceId}: ${error.message}", error)
        savedNotice = "Screenshot failed"
      } catch (error: IllegalArgumentException) {
        LOG.warn("Screenshot save failed for ${column.deviceId}: ${error.message}", error)
        savedNotice = "Screenshot failed"
      } finally {
        // NonCancellable so the socket is still closed when this coroutine is cancelled (pane close
        // /
        // superseded capture); IO so the unsubscribe write + close don't run on the UI thread.
        withContext(NonCancellable + ioDispatcher) { stream.dispose() }
      }
    }
  }
}

@Composable
internal fun rememberStreamCaptureMemory(column: DeviceColumn): StreamCaptureMemory {
  val savedNoticeState = remember(column.deviceId) { mutableStateOf<String?>(null) }
  val captureRequestState = remember(column.deviceId) { mutableStateOf(0) }
  return StreamCaptureMemory(savedNoticeState, captureRequestState)
}

private val LOG = LoggerFactory.getLogger("WorkspaceShell")
