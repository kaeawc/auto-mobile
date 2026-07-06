package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import java.io.IOException
import java.util.concurrent.CancellationException as JavaCancellationException
import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Behavioral coverage for the `ACTION_EXTRACT_HIERARCHY` error-frame emission (PR #3126,
 * issue #3089), the runner-side follow-up requested in issue #3131. The daemon side is covered by
 * `test/features/observe/CtrlProxyClient.test.ts`; before this test the runner side was covered
 * only structurally (`BroadcastGuardAdoptionTest`) and by compilation — nothing asserted the actual
 * `ErrorResponse(requestId = uuid)` frame content on each failure branch.
 *
 * `handleCommand` is a private `AccessibilityService` method, so rather than stand up a Robolectric
 * harness the failure-decision + frame-construction was extracted into the pure
 * [HierarchyExtractErrorFrames] (mirroring how [BroadcastGuardScanner] isolates testable logic);
 * these tests exercise that helper directly against every branch enumerated in the issue.
 */
class HierarchyExtractErrorFramesTest {

  private companion object {
    const val UUID = "req-1234"
  }

  // extractHierarchy returns null → frame with error = "Failed to extract hierarchy",
  // requestId = uuid.
  @Test
  fun `null hierarchy emits correlated failure frame`() {
    val frame = HierarchyExtractErrorFrames.nullResultFrame(UUID)

    assertEquals(
      ErrorResponse(
        timestamp = frame!!.timestamp,
        requestId = UUID,
        error = "Failed to extract hierarchy",
      ),
      frame,
    )
  }

  // extractHierarchy throws → frame with error containing the cause, requestId = uuid.
  @Test
  fun `thrown extraction emits correlated frame carrying the cause`() {
    val frame = HierarchyExtractErrorFrames.thrownFrame(UUID, IOException("adb pipe closed"))

    assertEquals(UUID, frame!!.requestId)
    assertEquals("Hierarchy extraction failed: adb pipe closed", frame.error)
  }

  // A throwable with no message falls back to its simple class name rather than emitting a blank
  // cause — the awaiting daemon still gets an actionable frame.
  @Test
  fun `thrown extraction with no message falls back to the class name`() {
    val frame = HierarchyExtractErrorFrames.thrownFrame(UUID, IllegalStateException())

    assertEquals("Hierarchy extraction failed: IllegalStateException", frame!!.error)
  }

  // CancellationException during extraction → no error frame (the caller rethrows it so cooperative
  // cancellation unwinds cleanly).
  @Test
  fun `kotlin CancellationException emits no frame`() {
    assertNull(HierarchyExtractErrorFrames.thrownFrame(UUID, CancellationException("cancelled")))
  }

  @Test
  fun `java CancellationException emits no frame`() {
    // kotlinx's CancellationException is a typealias for
    // java.util.concurrent.CancellationException;
    // guard against the JDK type explicitly so a JobCancellationException subtype is never
    // converted into a client-facing error frame.
    assertNull(
      HierarchyExtractErrorFrames.thrownFrame(UUID, JavaCancellationException("cancelled"))
    )
  }

  // blank/missing uuid → no WebSocket frame (only the legacy ADB ACTION_OPERATION_RESULT is sent).
  @Test
  fun `null uuid produces no frame on either failure branch`() {
    assertNull(HierarchyExtractErrorFrames.nullResultFrame(null))
    assertNull(HierarchyExtractErrorFrames.thrownFrame(null, IOException("boom")))
  }

  @Test
  fun `blank uuid produces no frame on either failure branch`() {
    assertNull(HierarchyExtractErrorFrames.nullResultFrame("   "))
    assertNull(HierarchyExtractErrorFrames.thrownFrame("", IOException("boom")))
  }

  // The helper's error strings must stay in lock-step with what handleCommand also passes to the
  // legacy ADB sendResult path, so both channels report the same failure.
  @Test
  fun `error strings match the documented contract`() {
    assertEquals("Failed to extract hierarchy", HierarchyExtractErrorFrames.NULL_HIERARCHY_ERROR)
    assertTrue(
      HierarchyExtractErrorFrames.thrownFrame(UUID, IOException("x"))!!
        .error
        .startsWith(HierarchyExtractErrorFrames.THROWN_PREFIX)
    )
  }
}
