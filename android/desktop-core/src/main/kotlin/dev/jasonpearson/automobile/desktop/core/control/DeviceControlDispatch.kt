package dev.jasonpearson.automobile.desktop.core.control

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import kotlinx.coroutines.withContext

internal suspend fun DeviceControlSession.execute(command: DeviceControlInputCommand) {
  // A streamed drag holds this slot for its whole lifetime and runs its own consumer loop, so it
  // bypasses the one-shot machinery below (which assumes a single request per command).
  if (command is DeviceControlInputCommand.StreamGesture) {
    executeStreamGesture(command)
    return
  }
  // A command can wait behind another input while the sources rotate. Recheck at the FIFO
  // consumer boundary so a coordinate captured before disagreement cannot reach the daemon.
  if (
    (command is DeviceControlInputCommand.Tap || command is DeviceControlInputCommand.Swipe) &&
      !coordinatesAreStillDispatchable(command.snapshot)
  ) {
    command.client?.close()
    return
  }
  var error: String? = null
  val forwarded =
    try {
      withContext(ioDispatcher) {
        // The main-to-IO dispatcher hop admits another observation before the daemon call.
        // This volatile read is the final rotation gate before coordinates leave the process.
        if (
          (command is DeviceControlInputCommand.Tap ||
            command is DeviceControlInputCommand.Swipe) &&
            !rotationIsStillDispatchable(command.snapshot)
        ) {
          false
        } else {
          forward(command) { message -> error = message }
          true
        }
      }
    } finally {
      command.client?.close()
    }
  if (!forwarded) return
  val message = error
  withContext(uiContext) {
    if (message == null) {
      // Success: the device changed, so wait for the observation stream to supersede the snapshot
      // this input was dispatched through. No polling, no client-side re-observe.
      refreshTracker.onInputSucceeded(command.snapshot, nowMs())
    } else {
      // Failure: the device did not change, so nothing on screen is stale and nothing is cleared.
      refreshTracker.onInputFailed()
      if (DeviceControlSession.isStaleFrameContextError(message)) {
        // Inputs already queued against the rejected snapshot must not become implicit retries,
        // but a user can receive a newer paired frame and enqueue a valid command while this
        // one is in flight. Reject only this context so that newer command stays in gesture
        // order and can still reach the device.
        val newestDiscardedToken = dispatcher.discardFrameContext(command.snapshot.frameContext)
        if (newestDiscardedToken == errorToken.get()) {
          // A discarded retry owned the current claim. Its removal must not also suppress the
          // stale rejection that explains why control is unavailable.
          errorToken.set(command.token)
        }
        if (!hasDifferentInteractionFrameContextThan(command.snapshot)) {
          staleContextRejectedFrameContext = command.snapshot.frameContext
          interactionSnapshot = null
        }
      }
      // Serialize the claim check with the banner write on the UI context so a superseded
      // attempt's stale error cannot resurrect a banner a newer attempt already cleared.
      if (command.token == errorToken.get()) publishError(message)
    }
  }
}

/**
 * Hand one command to the matching typed forwarder. The device id comes from the command's own
 * snapshot in EVERY branch, never from a selection resolved at dispatch time.
 */
internal fun DeviceControlSession.forward(
  command: DeviceControlInputCommand,
  onError: (String) -> Unit,
) {
  val target =
    DeviceInputTarget(
      command.client,
      command.platform,
      command.snapshot.deviceId,
      onError,
      command.snapshot.frameContext,
    )
  when (command) {
    is DeviceControlInputCommand.Tap ->
      forwarder.forwardTap(
        point = command.point,
        target = target,
      )
    is DeviceControlInputCommand.Swipe ->
      forwarder.forwardSwipe(
        start = command.start,
        end = command.end,
        durationMs = command.durationMs,
        target = target,
      )
    is DeviceControlInputCommand.PressButton ->
      forwarder.forwardPressButton(
        button = command.button,
        target = target,
      )
    is DeviceControlInputCommand.TypeText ->
      forwarder.forwardTypeText(
        text = command.text,
        target = target,
      )
    is DeviceControlInputCommand.SendKey ->
      forwarder.forwardKey(
        key = command.key,
        target = target,
      )
    is DeviceControlInputCommand.StreamGesture ->
      // Streamed gestures are driven by executeStreamGesture, never the one-shot forwarder.
      error("StreamGesture is executed directly, not forwarded")
  }
}

/**
 * Run one streamed drag to completion, holding the FIFO slot for its lifetime. Mirrors [execute]'s
 * outer shape — dispatchability recheck, IO-hop, client close, single success/failure settle — but
 * the actual work is the streaming consumer [streamGesture], which either streams live or, when the
 * client cannot, drains the events into one atomic swipe. One `refreshTracker` settle fires at the
 * end (the drag changed the device exactly once, on release), not per move.
 */
internal suspend fun DeviceControlSession.executeStreamGesture(
  command: DeviceControlInputCommand.StreamGesture,
) {
  if (!coordinatesAreStillDispatchable(command.snapshot)) {
    drainAndClose(command.events)
    command.client?.close()
    return
  }
  var error: String? = null
  val forwarded =
    try {
      withContext(ioDispatcher) {
        if (!rotationIsStillDispatchable(command.snapshot)) {
          drainAndClose(command.events)
          false
        } else {
          streamGesture(command) { message -> error = message }
          true
        }
      }
    } finally {
      command.client?.close()
    }
  if (!forwarded) return
  val message = error
  withContext(uiContext) {
    if (message == null) {
      refreshTracker.onInputSucceeded(command.snapshot, nowMs())
    } else {
      refreshTracker.onInputFailed()
      if (command.token == errorToken.get()) publishError(message)
    }
  }
}

/**
 * Everything [reset] does except forgetting the observed coordinate spaces.
 *
 * Used by the space-transition paths, which have already recorded the NEW space as their baseline:
 * forgetting it there would make the next observation re-establish a baseline and could report the
 * same flip twice. Every other caller wants the full [reset] — a new device or a reconnected stream
 * must not be compared against the previous context's space.
 */
internal fun DeviceControlSession.resetPreservingSpaceBaseline() {
  dispatcher.reset()
  errorToken.incrementAndGet()
  refreshTracker.reset()
  staleContextRejectedFrameContext = null
  renderSnapshot = null
  interactionSnapshot = null
  publishError(null)
}

internal fun DeviceControlSession.hasDifferentInteractionFrameContextThan(
  snapshot: DeviceFrameSnapshot,
): Boolean = interactionSnapshot?.frameContext?.let { it != snapshot.frameContext } == true
