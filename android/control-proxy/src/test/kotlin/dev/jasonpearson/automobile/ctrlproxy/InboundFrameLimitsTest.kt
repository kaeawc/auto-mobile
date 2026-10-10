package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetLimits
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class InboundFrameLimitsTest {
  private val limits = InboundFrameLimits(mapOf("put_prototype_asset" to 100L))

  private fun asset(data: String, typeFirst: Boolean = true): ByteArray {
    val body = """"requestId":"r1","id":"hero","mimeType":"image/png","dataBase64":"$data""""
    val type = """"type":"put_prototype_asset""""
    return (if (typeFirst) "{$type,$body}" else "{$body,$type}").encodeToByteArray()
  }

  @Test
  fun `a frame above its type's cap is rejected with the type, requestId and sizes`() {
    val frame = asset("A".repeat(200))
    val rejection = checkNotNull(limits.check(frame))
    assertEquals("put_prototype_asset", rejection.type)
    assertEquals("r1", rejection.requestId)
    assertEquals(frame.size.toLong(), rejection.frameBytes)
    assertEquals(100L, rejection.maxBytes)
  }

  @Test
  fun `the type is found after the payload`() {
    val rejection = checkNotNull(limits.check(asset("A".repeat(200), typeFirst = false)))
    assertEquals("put_prototype_asset", rejection.type)
    assertEquals("r1", rejection.requestId)
  }

  @Test
  fun `a frame within its type's cap passes`() {
    val frame = """{"type":"put_prototype_asset","dataBase64":"${"A".repeat(40)}"}"""
    assertNull(limits.check(frame.encodeToByteArray()))
  }

  @Test
  fun `a type without a cap keeps only the transport ceiling`() {
    val frame = """{"type":"request_set_text","text":"${"x".repeat(500)}"}"""
    assertNull(limits.check(frame.encodeToByteArray()))
  }

  @Test
  fun `an unreadable header passes through to the full decode`() {
    assertNull(limits.check("not json ${"x".repeat(200)}".encodeToByteArray()))
    assertNull(limits.check("""["put_prototype_asset","${"x".repeat(200)}"]""".encodeToByteArray()))
    // The syntax error precedes the type, so the type is never reached.
    assertNull(
      limits.check(
        """{"dataBase64":"${"A".repeat(200)}" "x","type":"put_prototype_asset"}"""
          .encodeToByteArray(),
      ),
    )
  }

  @Test
  fun `header peek skips nested and non-string values`() {
    val frame =
      """{"spec":{"type":"nested","items":[1,{"requestId":"inner"}]},"requestId":7,"type":"put_prototype_asset"}"""
    assertEquals(
      InboundFrameHeader(type = "put_prototype_asset", requestId = null),
      InboundFrameHeader.peek(frame.encodeToByteArray()),
    )
  }

  @Test
  fun `default caps hold asset removals to the envelope and puts to the encoded asset limit`() {
    val removal =
      """{"type":"remove_prototype_asset","requestId":"r2","id":"${"h".repeat(70 * 1024)}"}"""
    val rejection = checkNotNull(InboundFrameLimits.DEFAULT.check(removal.encodeToByteArray()))
    assertEquals(InboundFrameLimits.ENVELOPE_ALLOWANCE_BYTES, rejection.maxBytes)
    assertEquals("r2", rejection.requestId)
    // Just above the put cap: the largest encodable asset plus the whole envelope allowance.
    val putCap =
      PrototypeAssetLimits().maxEncodedLength + InboundFrameLimits.ENVELOPE_ALLOWANCE_BYTES
    val oversizedPut = asset("A".repeat(putCap.toInt()))
    assertEquals(putCap, InboundFrameLimits.DEFAULT.check(oversizedPut)?.maxBytes)
    assertNull(InboundFrameLimits.DEFAULT.check(asset("A".repeat(64 * 1024))))
  }
}
