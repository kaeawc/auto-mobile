package dev.jasonpearson.automobile.sdk.network

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import dev.jasonpearson.automobile.protocol.NetworkMockRuleDto
import dev.jasonpearson.automobile.protocol.NetworkMockRuleReportContract
import dev.jasonpearson.automobile.protocol.RejectedNetworkMockRule
import dev.jasonpearson.automobile.sdk.ControlBroadcastReply
import dev.jasonpearson.automobile.sdk.SdkConstants
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.TIRAMISU])
class NetworkMockRuleStoreReceiverTest {

  @Test
  fun `network control receiver accepts only CtrlProxy owned V2 permission`() {
    assertEquals(
      "dev.jasonpearson.automobile.ctrlproxy.permission.NETWORK_CONTROL_V2",
      SdkConstants.PERMISSION_NETWORK_CONTROL,
    )
  }

  /** Repeat initialization remains a no-op and teardown unregisters the receiver (#3599). */
  @Test
  fun `registerReceiver is idempotent and unregister allows re-register`() {
    val store = NetworkMockRuleStore()
    val context = mockk<Context>(relaxed = true)
    val receiver = slot<BroadcastReceiver>()
    every {
      context.registerReceiver(
        any<BroadcastReceiver>(),
        any<IntentFilter>(),
        SdkConstants.PERMISSION_NETWORK_CONTROL,
        null,
        Context.RECEIVER_EXPORTED,
      )
    } returns null

    store.registerReceiver(context)
    store.registerReceiver(context) // guarded no-op

    verify(exactly = 1) {
      context.registerReceiver(
        capture(receiver),
        any<IntentFilter>(),
        SdkConstants.PERMISSION_NETWORK_CONTROL,
        null,
        Context.RECEIVER_EXPORTED,
      )
    }

    store.unregisterReceiver(context)
    store.unregisterReceiver(context) // guarded no-op
    verify(exactly = 1) { context.unregisterReceiver(receiver.captured) }

    // After unregister, registration can be restored.
    store.registerReceiver(context)
    verify(exactly = 2) {
      context.registerReceiver(
        any<BroadcastReceiver>(),
        any<IntentFilter>(),
        SdkConstants.PERMISSION_NETWORK_CONTROL,
        null,
        Context.RECEIVER_EXPORTED,
      )
    }
  }

  @Test
  fun `unregister without register is a no-op`() {
    val store = NetworkMockRuleStore()
    val context = mockk<Context>(relaxed = true)

    store.unregisterReceiver(context)

    verify(exactly = 0) { context.unregisterReceiver(any<BroadcastReceiver>()) }
  }

  private class FakeReply(
    override val isOrdered: Boolean,
    override var resultData: String? = null,
  ) : ControlBroadcastReply

  private fun rulesIntent(vararg dtos: NetworkMockRuleDto) =
    Intent(NetworkMockRuleStore.ACTION_NETWORK_MOCK_RULES)
      .putExtra(
        NetworkMockRuleStore.EXTRA_RULES_JSON,
        Json.encodeToString(ListSerializer(NetworkMockRuleDto.serializer()), dtos.toList()),
      )

  private fun dto(mockId: String, path: String = "/users") =
    NetworkMockRuleDto(
      mockId = mockId,
      host = "api.example.com",
      path = path,
      method = "*",
      statusCode = 500,
    )

  // Issue #10101: an ordered broadcast is answered with what the device engine rejected.
  @Test
  fun `an ordered rules broadcast is answered with the rejected rules and reasons`() {
    val store = NetworkMockRuleStore()
    val reply = FakeReply(isOrdered = true)

    store.handleControlBroadcast(
      rulesIntent(dto("ok"), dto("brace", path = "/items/{id}")),
      reply,
    )

    val report = NetworkMockRuleReportContract.decode(reply.resultData)
    assertEquals(listOf("brace"), report?.rejected?.map { it.mockId })
    assertTrue(report?.rejected?.single()?.reason?.startsWith("invalid regex: ") == true)
    assertEquals(1, store.getRuleCount())
  }

  @Test
  fun `an ordered rules broadcast with no rejection still answers with an empty report`() {
    val store = NetworkMockRuleStore()
    val reply = FakeReply(isOrdered = true)

    store.handleControlBroadcast(rulesIntent(dto("ok")), reply)

    assertEquals(
      emptyList<RejectedNetworkMockRule>(),
      NetworkMockRuleReportContract.decode(reply.resultData)?.rejected,
    )
  }

  @Test
  fun `a second app appends its rejections to the first app reply`() {
    val store = NetworkMockRuleStore()
    val reply =
      FakeReply(
        isOrdered = true,
        resultData =
          NetworkMockRuleReportContract.append(
            null,
            listOf(RejectedNetworkMockRule("other", "r")),
          ),
      )

    store.handleControlBroadcast(rulesIntent(dto("brace", path = "/items/{id}")), reply)

    assertEquals(
      listOf("other", "brace"),
      NetworkMockRuleReportContract.decode(reply.resultData)?.rejected?.map { it.mockId },
    )
  }

  @Test
  fun `a plain rules broadcast still applies the rules and sets no result`() {
    val store = NetworkMockRuleStore()
    val reply = FakeReply(isOrdered = false)

    store.handleControlBroadcast(
      rulesIntent(dto("ok"), dto("brace", path = "/items/{id}")),
      reply,
    )

    assertNull(reply.resultData)
    assertEquals(1, store.getRuleCount())
  }
}
