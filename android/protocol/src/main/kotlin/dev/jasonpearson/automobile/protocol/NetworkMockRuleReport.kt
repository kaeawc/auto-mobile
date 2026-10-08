package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** A mock rule an app's rule store skipped, with the device's own reason (issue #10101). */
@Serializable data class RejectedNetworkMockRule(val mockId: String, val reason: String)

/** What one app's rule store did with a pushed rule list. */
@Serializable data class NetworkMockRuleReport(val rejected: List<RejectedNetworkMockRule>)

/**
 * App-to-CtrlProxy reply for `set_network_mock_rules`, carried as the result data of the ordered
 * `NETWORK_MOCK_RULES` broadcast (the same ordered-broadcast reply the SDK event batch uses in the
 * opposite direction).
 *
 * Absent result data means no SDK receiver answered (an older SDK, or no SDK-embedded app): the
 * host reports the rules as sent but not confirmed. Present data means at least one app compiled
 * the rules; [NetworkMockRuleReport.rejected] lists what the device's regex engine refused. When
 * several apps answer the same broadcast their rejections are merged in delivery order.
 */
object NetworkMockRuleReportContract {
  private val json = Json { ignoreUnknownKeys = true }

  /** [previousJson] is the result data an earlier receiver left, or null for the first one. */
  fun append(previousJson: String?, rejected: List<RejectedNetworkMockRule>): String {
    val previous = decode(previousJson)?.rejected.orEmpty()
    return json.encodeToString(NetworkMockRuleReport(previous + rejected))
  }

  /** Null when no receiver answered or the data is not a report. */
  fun decode(resultData: String?): NetworkMockRuleReport? {
    if (resultData.isNullOrEmpty()) return null
    return runCatching { json.decodeFromString<NetworkMockRuleReport>(resultData) }.getOrNull()
  }
}
