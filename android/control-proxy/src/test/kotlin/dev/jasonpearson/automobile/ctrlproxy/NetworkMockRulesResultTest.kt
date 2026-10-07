package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.NetworkMockRuleReportContract
import dev.jasonpearson.automobile.protocol.RejectedNetworkMockRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Maps an app's ordered-broadcast reply to the `set_network_mock_rules_result` (issue #10101). */
class NetworkMockRulesResultTest {
  @Test
  fun `no app reply leaves the rejection fields null so the host reports not confirmed`() {
    val result = networkMockRulesResult("r1", null)

    assertEquals("r1", result.requestId)
    assertTrue(result.success)
    assertNull(result.rejectedMockIds)
    assertNull(result.rejectedReasons)
  }

  @Test
  fun `an empty report confirms every rule was installed`() {
    val result =
      networkMockRulesResult("r1", NetworkMockRuleReportContract.append(null, emptyList()))

    assertEquals(emptyList<String>(), result.rejectedMockIds)
    assertEquals(emptyMap<String, String>(), result.rejectedReasons)
  }

  @Test
  fun `a report names the rejected ids with the device reasons`() {
    val data =
      NetworkMockRuleReportContract.append(
        null,
        listOf(RejectedNetworkMockRule("m1", "invalid regex: Illegal repetition")),
      )

    val result = networkMockRulesResult("r1", data)

    assertEquals(listOf("m1"), result.rejectedMockIds)
    assertEquals(mapOf("m1" to "invalid regex: Illegal repetition"), result.rejectedReasons)
  }

  @Test
  fun `a broadcast failure is a failed result carrying the error`() {
    val result = networkMockRulesFailure("r1", "boom")

    assertFalse(result.success)
    assertEquals("boom", result.error)
    assertNull(result.rejectedMockIds)
  }
}
