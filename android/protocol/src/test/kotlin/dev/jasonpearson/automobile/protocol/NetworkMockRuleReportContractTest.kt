package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test

class NetworkMockRuleReportContractTest {
  @Test
  fun `no result data means no receiver answered`() {
    assertNull(NetworkMockRuleReportContract.decode(null))
    assertNull(NetworkMockRuleReportContract.decode(""))
  }

  @Test
  fun `data that is not a report is treated as unanswered`() {
    assertNull(NetworkMockRuleReportContract.decode("not json"))
  }

  @Test
  fun `an empty rejection list is a confirmation distinct from no answer`() {
    val data = NetworkMockRuleReportContract.append(null, emptyList())

    assertEquals(emptyList(), NetworkMockRuleReportContract.decode(data)?.rejected)
  }

  @Test
  fun `rejections from a later receiver are appended in delivery order`() {
    val first =
      NetworkMockRuleReportContract.append(null, listOf(RejectedNetworkMockRule("a", "invalid")))
    val second =
      NetworkMockRuleReportContract.append(first, listOf(RejectedNetworkMockRule("b", "bad")))

    assertEquals(
      listOf(RejectedNetworkMockRule("a", "invalid"), RejectedNetworkMockRule("b", "bad")),
      NetworkMockRuleReportContract.decode(second)?.rejected,
    )
  }

  @Test
  fun `set_network_mock_rules_result omits the rejection fields when no app confirmed`() {
    val json = Json { encodeDefaults = false }
    val unconfirmed: WebSocketResponse = SetNetworkMockRulesResult(timestamp = 1L, requestId = "r1")
    val encoded = json.encodeToString(unconfirmed)

    assertFalse(encoded.contains("rejectedMockIds"))
    assertEquals(
      unconfirmed,
      json.decodeFromString(WebSocketResponse.serializer(), encoded),
    )
  }

  @Test
  fun `set_network_mock_rules_result carries the rejected ids and reasons`() {
    val json = Json { encodeDefaults = true }
    val response: WebSocketResponse =
      SetNetworkMockRulesResult(
        timestamp = 1L,
        requestId = "r1",
        rejectedMockIds = listOf("m1"),
        rejectedReasons = mapOf("m1" to "invalid regex: x"),
      )

    val encoded = json.encodeToString(response)

    assertEquals(true, encoded.contains("\"type\":\"set_network_mock_rules_result\""))
    assertEquals(response, json.decodeFromString(WebSocketResponse.serializer(), encoded))
  }
}
