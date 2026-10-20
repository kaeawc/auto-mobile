package dev.jasonpearson.automobile.ctrlproxy

import android.content.BroadcastReceiver
import android.content.Intent
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.network.NetworkMockRuleStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class SdkControlControllerTest {
  private class FakeHost : SdkControlController.Host {
    val plain = mutableListOf<Intent>()
    val ordered = mutableListOf<Pair<Intent, BroadcastReceiver>>()
    val replies = mutableListOf<SetNetworkMockRulesResult>()
    var failSend = false

    override fun sendBroadcast(intent: Intent) {
      if (failSend) throw IllegalStateException("boom")
      plain += intent
    }

    override fun sendOrderedBroadcast(intent: Intent, resultReceiver: BroadcastReceiver) {
      if (failSend) throw IllegalStateException("boom")
      ordered += intent to resultReceiver
    }

    override fun replyNetworkMockRules(result: SetNetworkMockRulesResult) {
      replies += result
    }
  }

  private val host = FakeHost()
  private val store = RecompositionStore()
  private val controller = SdkControlController(host, store)

  @Test
  fun recompositionTrackingBroadcastsTheFlag() {
    controller.setRecompositionTrackingEnabled(true)

    assertTrue(store.isEnabled())
    val intent = host.plain.single()
    assertEquals(AutoMobileSDK.ACTION_RECOMPOSITION_CONTROL, intent.action)
    assertTrue(intent.getBooleanExtra(AutoMobileSDK.EXTRA_RECOMPOSITION_ENABLED, false))
  }

  @Test
  fun recompositionBroadcastFailureIsSwallowed() {
    host.failSend = true

    controller.setRecompositionTrackingEnabled(false)

    assertTrue(host.plain.isEmpty())
  }

  @Test
  fun uncorrelatedMockRulesUsePlainBroadcast() {
    controller.broadcastNetworkMockRules(null, "[]")

    val intent = host.plain.single()
    assertEquals(NetworkMockRuleStore.ACTION_NETWORK_MOCK_RULES, intent.action)
    assertEquals("[]", intent.getStringExtra(NetworkMockRuleStore.EXTRA_RULES_JSON))
    assertTrue(host.ordered.isEmpty())
  }

  @Test
  fun correlatedMockRulesUseOrderedBroadcastWithReplyReceiver() {
    controller.broadcastNetworkMockRules("req-1", "[{}]")

    val (intent, receiver) = host.ordered.single()
    assertEquals(NetworkMockRuleStore.ACTION_NETWORK_MOCK_RULES, intent.action)
    assertTrue(receiver is NetworkMockRulesReplyReceiver)
    assertTrue(host.plain.isEmpty())
  }

  @Test
  fun correlatedMockRulesFailureRepliesWithFailureFrame() {
    host.failSend = true

    controller.broadcastNetworkMockRules("req-2", "[]")

    val reply = host.replies.single()
    assertEquals("req-2", reply.requestId)
    assertFalse(reply.success)
    assertTrue(reply.error!!.startsWith("Failed to broadcast network mock rules"))
  }

  @Test
  fun uncorrelatedMockRulesFailureRepliesNothing() {
    host.failSend = true

    controller.broadcastNetworkMockRules(null, "[]")

    assertTrue(host.replies.isEmpty())
  }

  @Test
  fun errorSimulationCarriesOnlyProvidedExtras() {
    controller.broadcastNetworkErrorSimulation(true, "timeout", 3, null, null)

    val intent = host.plain.single()
    assertEquals(NetworkMockRuleStore.ACTION_NETWORK_ERROR_SIMULATION, intent.action)
    assertTrue(intent.getBooleanExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_ENABLED, false))
    assertEquals("timeout", intent.getStringExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_TYPE))
    assertEquals(3, intent.getIntExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_LIMIT, -1))
    assertFalse(intent.hasExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_EXPIRES_AT))
    assertFalse(intent.hasExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_REMAINING_MS))
  }

  @Test
  fun errorSimulationCarriesTimingExtras() {
    controller.broadcastNetworkErrorSimulation(false, null, null, 99L, 5L)

    val intent = host.plain.single()
    assertEquals(99L, intent.getLongExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_EXPIRES_AT, -1L))
    assertEquals(5L, intent.getLongExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_REMAINING_MS, -1L))
    assertNull(intent.getStringExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_TYPE))
  }
}
