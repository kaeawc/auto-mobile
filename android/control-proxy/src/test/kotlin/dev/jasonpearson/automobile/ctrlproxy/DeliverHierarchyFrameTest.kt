package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Behavioral guard for the issue #5469 follow-up leak fix.
 *
 * [deliverHierarchyFrame] centralizes "serialize once → write file → broadcast → always release the
 * frame-context entry" so that hoisting serialization out of the writer/broadcaster's try/catch can
 * no longer leak [CtrlProxy.extractedHierarchyFrameContexts] entries on an encode failure.
 *
 * These tests drive the real function with a counting serializer and fake writer/broadcaster — no
 * AccessibilityService, no device — proving the contract directly rather than by source shape:
 * 1. a single delivery serializes exactly once and the SAME string reaches the writer and the
 *    broadcaster (single-serialization reuse);
 * 2. a serializer that throws still releases the frame-context entry (the leak regression guard)
 *    and never writes or broadcasts, and the failure propagates so the caller drops just that
 *    frame;
 * 3. a writer or broadcaster failure likewise still releases the entry.
 */
class DeliverHierarchyFrameTest {

  private class Fakes {
    var serializeCount = 0
    val written = mutableListOf<String>()
    val broadcast = mutableListOf<String>()
    var releaseCount = 0
  }

  @Test
  fun `a single delivery serializes once and reuses the same string for write and broadcast`() {
    val fakes = Fakes()
    val payload = "{\"hierarchy\":\"once\"}"

    runBlocking {
      deliverHierarchyFrame(
        serialize = {
          fakes.serializeCount++
          payload
        },
        write = { fakes.written += it },
        broadcast = { fakes.broadcast += it },
        releaseFrameContext = { fakes.releaseCount++ },
      )
    }

    assertEquals("serialize must run exactly once per delivery", 1, fakes.serializeCount)
    assertEquals(listOf(payload), fakes.written)
    assertEquals(listOf(payload), fakes.broadcast)
    // The wire frame and the debug file must be the identical string instance (reuse, not
    // re-encode).
    assertSame(
      "the writer and broadcaster must receive the SAME serialized instance",
      fakes.written.single(),
      fakes.broadcast.single(),
    )
    assertEquals("the frame-context entry must be released once", 1, fakes.releaseCount)
  }

  @Test
  fun `a serializer failure still releases the frame-context entry and skips write and broadcast`() {
    val fakes = Fakes()
    val boom = RuntimeException("NaN textSizeInPx cannot be encoded")

    val thrown =
      try {
        runBlocking {
          deliverHierarchyFrame(
            serialize = {
              fakes.serializeCount++
              throw boom
            },
            write = { fakes.written += it },
            broadcast = { fakes.broadcast += it },
            releaseFrameContext = { fakes.releaseCount++ },
          )
        }
        null
      } catch (e: RuntimeException) {
        e
      }

    assertEquals("serialize was attempted once", 1, fakes.serializeCount)
    assertTrue("nothing may be written when serialization fails", fakes.written.isEmpty())
    assertTrue("nothing may be broadcast when serialization fails", fakes.broadcast.isEmpty())
    assertEquals(
      "the frame-context entry MUST still be released on serialize failure (leak fix #5469)",
      1,
      fakes.releaseCount,
    )
    assertSame("the delivery failure must propagate so the caller drops the frame", boom, thrown)
  }

  @Test
  fun `a writer failure still releases the frame-context entry`() {
    val fakes = Fakes()
    val boom = RuntimeException("disk full")

    val thrown =
      try {
        runBlocking {
          deliverHierarchyFrame(
            serialize = {
              fakes.serializeCount++
              "payload"
            },
            write = { throw boom },
            broadcast = { fakes.broadcast += it },
            releaseFrameContext = { fakes.releaseCount++ },
          )
        }
        null
      } catch (e: RuntimeException) {
        e
      }

    assertEquals(1, fakes.serializeCount)
    assertTrue("broadcast must not run after a write failure", fakes.broadcast.isEmpty())
    assertEquals(
      "the frame-context entry MUST still be released on write failure (leak fix #5469)",
      1,
      fakes.releaseCount,
    )
    assertSame(boom, thrown)
  }

  @Test
  fun `a broadcaster failure still releases the frame-context entry`() {
    val fakes = Fakes()
    val boom = RuntimeException("socket closed")

    val thrown =
      try {
        runBlocking {
          deliverHierarchyFrame(
            serialize = {
              fakes.serializeCount++
              "payload"
            },
            write = { fakes.written += it },
            broadcast = { throw boom },
            releaseFrameContext = { fakes.releaseCount++ },
          )
        }
        null
      } catch (e: RuntimeException) {
        e
      }

    assertEquals(1, fakes.serializeCount)
    assertEquals("the write ran before the broadcast failed", listOf("payload"), fakes.written)
    assertEquals(
      "the frame-context entry MUST still be released on broadcast failure (leak fix #5469)",
      1,
      fakes.releaseCount,
    )
    assertSame(boom, thrown)
  }

  @Test
  fun `delivery models the real leak seam an identity map entry is removed even on failure`() {
    // Mirror the real seam: a strong-keyed identity map that only the delivery removes from. Prove
    // a
    // failed encode does not retain the key (the exact heap-exhaustion path from repeated invalid
    // hierarchies).
    val hierarchy = Any()
    val frameContexts = java.util.IdentityHashMap<Any, String>()
    frameContexts[hierarchy] = "epoch:token"

    try {
      runBlocking {
        deliverHierarchyFrame(
          serialize = { throw RuntimeException("Infinity") },
          write = {},
          broadcast = {},
          releaseFrameContext = { frameContexts.remove(hierarchy) },
        )
      }
      fail("expected the serialize failure to propagate")
    } catch (_: RuntimeException) {
      // expected — the caller drops the frame
    }

    assertNull("a failed delivery must not retain the hierarchy key", frameContexts[hierarchy])
    assertTrue(frameContexts.isEmpty())
  }
}
