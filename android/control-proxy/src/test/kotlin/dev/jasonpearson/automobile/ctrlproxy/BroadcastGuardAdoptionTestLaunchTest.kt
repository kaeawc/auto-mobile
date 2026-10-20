package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Broadcast guard scanner contracts for request-correlated service-scope launches. */
internal class BroadcastGuardAdoptionTestLaunchTest {

  @Test
  fun `flags raw serviceScope launch that captures requestId without context`() {
    val src =
      """
      class Fake {
        private val serviceScope: CoroutineScope = TODO()

        private fun dispatch(requestId: String?) {
          serviceScope.launch {
            val value = doRealWork()
            broadcastFooResult(requestId, value)
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.RAW_REQUEST_ID_LAUNCH to "serviceScope.launch"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `does not flag serviceScope launch that attaches RequestIdContext`() {
    val src =
      """
      class Fake {
        private val serviceScope: CoroutineScope = TODO()

        private fun dispatch(requestId: String?) {
          serviceScope.launch(RequestIdContext(requestId)) {
            val value = doRealWork()
            broadcastFooResult(requestId, value)
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "context-tagged launch must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
  }

  @Test
  fun `does not flag serviceScope launch that attaches named-argument RequestIdContext`() {
    val src =
      """
      class Fake {
        private val serviceScope: CoroutineScope = TODO()

        private fun dispatch(requestId: String?) {
          serviceScope.launch(RequestIdContext(requestId = requestId)) {
            val value = doRealWork()
            broadcastFooResult(requestId, value)
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "named-argument context-tagged launch must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
  }

  @Test
  fun `flags serviceScope launch that attaches a non-correlated RequestIdContext`() {
    val src =
      """
      class Fake {
        private val serviceScope: CoroutineScope = TODO()

        private fun dispatch(requestId: String?) {
          serviceScope.launch(RequestIdContext(null)) {
            val value = doRealWork()
            broadcastFooResult(requestId, value)
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.RAW_REQUEST_ID_LAUNCH to "serviceScope.launch"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `does not flag helper-routed request-correlated launch`() {
    val src =
      """
      class Fake {
        private fun dispatch(requestId: String?) {
          launchRequestScope(requestId) {
            val value = doRealWork()
            broadcastFooResult(requestId, value)
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "helper-routed launch must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
  }

  @Test
  fun `does not treat block-argument launch calls as trailing-lambda launch bodies`() {
    val src =
      """
      class Fake {
        private val serviceScope: CoroutineScope = TODO()

        private fun launchRequestScope(
          requestId: String?,
          block: suspend CoroutineScope.() -> Unit,
        ): Job = serviceScope.launch(context = RequestIdContext(requestId), block = block)
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(0, result.rawLaunchBlocks)
    assertTrue(
      "block-argument launch must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
  }

  @Test
  fun `flags inline block-argument serviceScope launch that captures requestId without context`() {
    val src =
      """
      class Fake {
        private val serviceScope: CoroutineScope = TODO()

        private fun dispatch(requestId: String?) {
          serviceScope.launch(block = {
            val value = doRealWork()
            broadcastFooResult(requestId, value)
          })
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.RAW_REQUEST_ID_LAUNCH to "serviceScope.launch"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `flags raw serviceScope launch that captures a requestId alias without context`() {
    val src =
      """
      class Fake {
        private val serviceScope: CoroutineScope = TODO()

        private fun dispatch(requestId: String?) {
          val id = requestId
          serviceScope.launch {
            val value = doRealWork()
            broadcastFooResult(id, value)
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertEquals(
      listOf(BroadcastGuardScanner.Kind.RAW_REQUEST_ID_LAUNCH to "serviceScope.launch"),
      result.violations.map { it.kind to it.symbol },
    )
  }

  @Test
  fun `does not flag uncorrelated serviceScope launch`() {
    val src =
      """
      class Fake {
        private val serviceScope: CoroutineScope = TODO()

        private fun subscribe() {
          serviceScope.launch {
            broadcastNavigationEvent(event)
          }
        }
      }
      """
        .trimIndent()

    val result = BroadcastGuardScanner.scan(src)

    assertTrue(
      "uncorrelated push work must not be flagged: ${result.violations}",
      result.violations.isEmpty(),
    )
  }
}
