package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.DisplayPanelFingerprint
import dev.jasonpearson.automobile.protocol.DisplayTransitionEvent
import dev.jasonpearson.automobile.protocol.InteractionEvent
import dev.jasonpearson.automobile.protocol.NetworkMockRuleReportContract
import dev.jasonpearson.automobile.protocol.PackageEvent
import dev.jasonpearson.automobile.protocol.PackageEventData
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult

internal fun displayTransitionFrame(transition: DisplayTransition): String =
  typedResultFrame(
    DisplayTransitionEvent(
      timestamp = System.currentTimeMillis(),
      change = transition.change,
      displayId = transition.displayId,
      panelUniqueId = transition.panelUniqueId,
      panelFingerprint =
        transition.panelFingerprint?.let { DisplayPanelFingerprint(it.width, it.height) },
      width = transition.width,
      height = transition.height,
      state = transition.state,
      rotation = transition.rotation,
      deviceState = transition.deviceState,
    ),
  )

/** [eventJson] is the compact JSON text of the interaction, embedded as an object. */
internal fun interactionEventFrame(timestamp: Long, eventJson: String): String =
  typedResultFrame(InteractionEvent(timestamp = timestamp, event = eventJson))

/**
 * The `package_event` payload. `userId` is the Android user id; `uid` carries the raw package uid
 * when known and doubles as the marker that `userId` is a real user id: APKs that predate #10067
 * sent the uid in `userId` and no `uid`, which the host converts itself.
 */
internal fun packageEventFrame(outcome: PackageEventResult): String =
  typedResultFrame(
    PackageEvent(
      timestamp = outcome.timestamp,
      event =
        PackageEventData(
          outcome.action,
          outcome.packageName,
          outcome.userId,
          outcome.uid,
          outcome.isSystem,
          outcome.removedForAllUsers,
        ),
    ),
  )

/**
 * The `set_network_mock_rules_result` for an app's ordered-broadcast [resultData] (issue #10101).
 * Null data means no app answered, so the rejection fields stay null and the host reports the rules
 * as sent but not confirmed; a report, even an empty one, confirms them.
 */
internal fun networkMockRulesResult(
  requestId: String?,
  resultData: String?,
): SetNetworkMockRulesResult {
  val report = NetworkMockRuleReportContract.decode(resultData)
  return SetNetworkMockRulesResult(
    timestamp = System.currentTimeMillis(),
    requestId = requestId,
    rejectedMockIds = report?.rejected?.map { it.mockId },
    rejectedReasons = report?.rejected?.associate { it.mockId to it.reason },
  )
}

internal fun networkMockRulesFailure(requestId: String?, error: String): SetNetworkMockRulesResult =
  SetNetworkMockRulesResult(
    timestamp = System.currentTimeMillis(),
    requestId = requestId,
    success = false,
    error = error,
  )
