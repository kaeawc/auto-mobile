package dev.jasonpearson.automobile.desktop.core.failures

import dev.jasonpearson.automobile.desktop.core.daemon.AcknowledgeResponse
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresGroupsRequest
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresGroupsResponse
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresNotificationsRequest
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresNotificationsResponse
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresStreamClient
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresTimelineRequest
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresTimelineResponse
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.McpResourceContent
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.ContinuationInterceptor
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Before
import org.junit.Test

/**
 * #10142: the failures data sources run blocking daemon I/O, so they must run it on the injected IO
 * dispatcher (never the caller's UI thread), hand results back on the caller's dispatcher, bound
 * the MCP resource read, never stack polls, and stop polling when the collector is cancelled.
 *
 * "UI" is a [StandardTestDispatcher] (identified by its continuation interceptor) and "IO" is a
 * named single-thread executor (identified by thread name), so nothing here sleeps on the wall
 * clock; the blocking fakes are released through latches.
 */
class FailuresDataSourceOffMainThreadTest {

  private lateinit var io: ExecutorCoroutineDispatcher
  private lateinit var uiThread: ExecutorCoroutineDispatcher

  @Before
  fun setUp() {
    io = namedDispatcher(IO_THREAD_NAME)
    uiThread = namedDispatcher(UI_THREAD_NAME)
  }

  @After
  fun tearDown() {
    io.close()
    uiThread.close()
  }

  private fun namedDispatcher(name: String): ExecutorCoroutineDispatcher =
    Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, name).apply { isDaemon = true }
      }
      .asCoroutineDispatcher()

  // -- Streaming source: calls run on IO, results come back on the caller dispatcher --

  @Test
  fun `streaming calls run on the injected IO dispatcher and resume on the caller`() = runTest {
    val ui = StandardTestDispatcher(testScheduler)
    val client = BlockingStreamClient()
    val source = StreamingFailuresDataSource(client, ioDispatcher = io)

    val resumedOn = mutableListOf<CoroutineDispatcher?>()
    withContext(ui) {
      assertTrue(source.getFailureGroups() is Result.Success)
      resumedOn += currentCoroutineContext()[ContinuationInterceptor] as? CoroutineDispatcher
      assertTrue(source.getFailureGroups(dateRange = null, type = null) is Result.Success)
      assertTrue(
        source.getTimelineData(DateRange.TwentyFourHours, TimeAggregation.Hour) is Result.Success
      )
      assertTrue(source.pollNewNotifications() is Result.Success)
      assertTrue(source.acknowledgeNotifications(listOf(1, 2)) is Result.Success)
      resumedOn += currentCoroutineContext()[ContinuationInterceptor] as? CoroutineDispatcher
    }

    assertEquals(5, client.threadNames.size)
    assertTrue(
      client.threadNames.all { it.startsWith(IO_THREAD_NAME) },
      "ran on ${client.threadNames}",
    )
    assertTrue(resumedOn.all { it === ui })
  }

  @Test
  fun `streaming connection failure still maps to a typed error off the main thread`() = runTest {
    val client = BlockingStreamClient().apply { failure = McpConnectionException("socket gone") }
    val source = StreamingFailuresDataSource(client, ioDispatcher = io)

    val result = source.getFailureGroups()

    assertTrue(result is Result.Error)
    assertEquals("Failures stream socket not available: socket gone", result.message)
  }

  @Test
  fun `acknowledging nothing does not touch the socket`() = runTest {
    val client = BlockingStreamClient()
    val source = StreamingFailuresDataSource(client, ioDispatcher = io)

    assertEquals(Result.Success(0), source.acknowledgeNotifications(emptyList()))
    assertEquals(0, client.calls.get())
  }

  // -- Polling flows --

  @Test
  fun `a slow poll delays the next one instead of stacking and emits on the collector`() = runTest {
    val ui = StandardTestDispatcher(testScheduler)
    val client = BlockingStreamClient().apply { blockFirstCall = true }
    val source = StreamingFailuresDataSource(client, ioDispatcher = io)
    val emittedOn = CopyOnWriteArrayList<CoroutineDispatcher?>()

    val results =
      async(ui) {
        source
          .failureGroupsFlowWithParams(pollIntervalMs = 10)
          .onEach {
            emittedOn += currentCoroutineContext()[ContinuationInterceptor] as? CoroutineDispatcher
          }
          .take(2)
          .toList()
      }
    runCurrent()
    awaitLatch(client.firstCallStarted)

    // Plenty of virtual time passes while the first poll is blocked: no second poll may start.
    advanceTimeBy(60_000)
    runCurrent()
    assertEquals(1, client.calls.get())

    client.release.countDown()
    assertEquals(2, results.await().size)

    assertEquals(2, client.calls.get())
    assertEquals(1, client.maxInFlight.get())
    assertTrue(
      client.threadNames.all { it.startsWith(IO_THREAD_NAME) },
      "ran on ${client.threadNames}",
    )
    assertEquals(listOf<CoroutineDispatcher?>(ui, ui), emittedOn.toList())
  }

  @Test
  fun `cancelling the collector interrupts the in-flight poll and stops polling`() = runTest {
    val ui = StandardTestDispatcher(testScheduler)
    val client = BlockingStreamClient().apply { blockFirstCall = true }
    val source = StreamingFailuresDataSource(client, ioDispatcher = io)

    val job = launch(ui) { source.notificationsFlowWithParams(pollIntervalMs = 10).collect {} }
    runCurrent()
    awaitLatch(client.firstCallStarted)

    job.cancelAndJoin()
    advanceTimeBy(60_000)
    runCurrent()

    assertTrue(client.interrupted, "blocked socket read should be interrupted on cancellation")
    assertEquals(1, client.calls.get())
  }

  @Test
  fun `cancelling a one-shot load propagates cancellation instead of returning an error`() =
    runTest {
      val ui = StandardTestDispatcher(testScheduler)
      val client = BlockingStreamClient().apply { blockFirstCall = true }
      val source = StreamingFailuresDataSource(client, ioDispatcher = io)

      val load = async(ui) { source.getFailureGroups() }
      runCurrent()
      awaitLatch(client.firstCallStarted)
      load.cancel()

      assertFailsWith<CancellationException> { load.await() }
      assertTrue(client.interrupted)
    }

  // -- MCP source --

  @Test
  fun `mcp resource reads run on the injected IO dispatcher and resume on the caller`() =
    runBlocking {
      // Real threads (not virtual time): runTest fast-forwards the 30 s read timeout whenever it
      // waits on the real IO thread, which would time the read out spuriously.
      val client = ThreadRecordingClient()
      val source = McpFailuresDataSource({ client }, ioDispatcher = io)

      val resumedOn = mutableListOf<String>()
      withContext(uiThread) {
        client.responseText = FAILURES_JSON
        val groups = source.getFailureGroups()
        assertTrue(groups is Result.Success, "groups=$groups")
        resumedOn += Thread.currentThread().name
        client.responseText = TIMELINE_JSON
        val timeline = source.getTimelineData(DateRange.TwentyFourHours, TimeAggregation.Hour)
        assertTrue(timeline is Result.Success, "timeline=$timeline")
        resumedOn += Thread.currentThread().name
      }

      assertEquals(
        listOf(
          "automobile:failures",
          "automobile:failures/timeline?dateRange=24h&aggregation=hour",
        ),
        client.uris,
      )
      assertTrue(
        client.threadNames.all { it.startsWith(IO_THREAD_NAME) },
        "ran on ${client.threadNames}",
      )
      assertTrue(resumedOn.all { it.startsWith(UI_THREAD_NAME) }, "resumed on $resumedOn")
    }

  @Test
  fun `a stalled mcp resource read is bounded by the timeout and interrupted`() = runTest {
    val ui = StandardTestDispatcher(testScheduler)
    val client = ThreadRecordingClient().apply { block = true }
    val source = McpFailuresDataSource({ client }, ioDispatcher = io, readTimeoutMs = 5_000)

    val load = async(ui) { source.getFailureGroups() }
    runCurrent()
    awaitLatch(client.readStarted)
    advanceTimeBy(5_001)
    runCurrent()

    val result = load.await()
    assertTrue(result is Result.Error)
    assertTrue(result.message!!.contains("Timed out after 5000ms"), result.message)
    assertTrue(client.interrupted, "the stalled read should be interrupted by the timeout")
  }

  @Test
  fun `mcp connection failure still maps to a typed error`() = runBlocking {
    val client = ThreadRecordingClient().apply { failure = McpConnectionException("daemon down") }
    val source = McpFailuresDataSource({ client }, ioDispatcher = io)

    val result = source.getFailureGroups()

    assertTrue(result is Result.Error)
    assertEquals("MCP server not available: daemon down", result.message)
  }

  @Test
  fun `cancelling an mcp read propagates cancellation instead of returning an error`() = runTest {
    val ui = StandardTestDispatcher(testScheduler)
    val client = ThreadRecordingClient().apply { block = true }
    val source = McpFailuresDataSource({ client }, ioDispatcher = io)

    val load = async(ui) { source.getFailureGroups() }
    runCurrent()
    awaitLatch(client.readStarted)
    load.cancel()

    assertFailsWith<CancellationException> { load.await() }
    assertTrue(client.interrupted)
  }

  // -- Test doubles --

  /** Blocking-style [FailuresStreamClient]; the real one blocks in connect/readLine. */
  private class BlockingStreamClient : FailuresStreamClient {
    val threadNames = CopyOnWriteArrayList<String>()
    val calls = AtomicInteger()
    val maxInFlight = AtomicInteger()
    private val inFlight = AtomicInteger()
    val firstCallStarted = CountDownLatch(1)
    val release = CountDownLatch(1)

    @Volatile var blockFirstCall = false
    @Volatile var interrupted = false
    @Volatile var failure: McpConnectionException? = null

    private fun <T> call(response: T): T {
      threadNames += Thread.currentThread().name
      val callNumber = calls.incrementAndGet()
      maxInFlight.accumulateAndGet(inFlight.incrementAndGet()) { a, b -> maxOf(a, b) }
      try {
        failure?.let { throw it }
        if (blockFirstCall && callNumber == 1) {
          firstCallStarted.countDown()
          try {
            release.await(BLOCK_CEILING_SECONDS, TimeUnit.SECONDS)
          } catch (e: InterruptedException) {
            interrupted = true
            throw e
          }
        }
        return response
      } finally {
        inFlight.decrementAndGet()
      }
    }

    override fun pollNotifications(
      request: FailuresNotificationsRequest
    ): FailuresNotificationsResponse =
      call(FailuresNotificationsResponse(success = true, notifications = emptyList()))

    override fun pollGroups(request: FailuresGroupsRequest): FailuresGroupsResponse =
      call(FailuresGroupsResponse(success = true, groups = emptyList()))

    override fun pollTimeline(request: FailuresTimelineRequest): FailuresTimelineResponse =
      call(FailuresTimelineResponse(success = true, dataPoints = emptyList()))

    override fun acknowledge(notificationIds: List<Int>): AcknowledgeResponse =
      call(AcknowledgeResponse(success = true, acknowledgedCount = notificationIds.size))
  }

  /** [AutoMobileClient] whose only interesting member is the blocking [readResource]. */
  private class ThreadRecordingClient(
    private val delegate: FakeAutoMobileClient = FakeAutoMobileClient()
  ) : AutoMobileClient by delegate {
    val threadNames = CopyOnWriteArrayList<String>()
    val uris = CopyOnWriteArrayList<String>()
    val readStarted = CountDownLatch(1)

    @Volatile var responseText: String = FAILURES_JSON
    @Volatile var block = false
    @Volatile var interrupted = false
    @Volatile var failure: McpConnectionException? = null

    override fun readResource(uri: String): List<McpResourceContent> {
      threadNames += Thread.currentThread().name
      uris += uri
      failure?.let { throw it }
      if (block) {
        readStarted.countDown()
        try {
          CountDownLatch(1).await(BLOCK_CEILING_SECONDS, TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
          interrupted = true
          throw e
        }
      }
      return listOf(
        McpResourceContent(uri = uri, mimeType = "application/json", text = responseText)
      )
    }
  }

  /**
   * Waits for a blocking fake to have started; bounded so a regression fails instead of hanging.
   */
  private fun TestScope.awaitLatch(latch: CountDownLatch) {
    assertTrue(latch.await(BLOCK_CEILING_SECONDS, TimeUnit.SECONDS), "fake was never called")
  }

  private companion object {
    // Coroutine debug mode appends " @coroutine#N" to the thread name while a coroutine runs.
    const val IO_THREAD_NAME = "failures-io-test"

    const val UI_THREAD_NAME = "failures-ui-test"
    const val BLOCK_CEILING_SECONDS = 5L
    const val FAILURES_JSON = """{"groups":[],"generatedAt":"2026-10-05T00:00:00Z"}"""
    const val TIMELINE_JSON =
      """{"dataPoints":[],"dateRange":"24h","aggregation":"hour","previousPeriodTotals":{"crashes":0,"anrs":0,"toolFailures":0}}"""
  }
}
