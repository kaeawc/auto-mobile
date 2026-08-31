package dev.jasonpearson.automobile.desktop.core.daemon

import app.cash.turbine.test
import dev.jasonpearson.automobile.desktop.domain.KeyValueType
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.StringWriter
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json

/**
 * Covers the `storage_update` frame and the `request_observation` command added for #3930.
 *
 * Inbound frames are injected through `handleMessage` in the same way as the sibling stream tests;
 * no socket is involved.
 */
class ObservationStreamStorageTest {
  private val wireJson = Json { ignoreUnknownKeys = true }

  private fun storageFrame(
    key: String? = "\"theme\"",
    value: String? = "\"dark\"",
    valueType: String = "STRING",
  ) =
    """
    {
      "type": "storage_update",
      "deviceId": "emulator-5554",
      "timestamp": 9999,
      "storageEvent": {
        "packageName": "com.example",
        "fileName": "prefs.xml",
        "key": ${key ?: "null"},
        "value": ${value ?: "null"},
        "valueType": "$valueType",
        "timestamp": 1234,
        "sequenceNumber": 7
      }
    }
    """
      .trimIndent()

  @Test
  fun `emits a storage update from a storage_update frame`() = runTest {
    val client = ObservationStreamClient()

    client.storageUpdates.test {
      client.handleMessage(storageFrame())

      val update = awaitItem()
      assertEquals("emulator-5554", update.deviceId)
      assertEquals("com.example", update.packageName)
      assertEquals("prefs.xml", update.fileName)
      assertEquals("theme", update.key)
      assertEquals("dark", update.value)
      assertEquals(KeyValueType.String, update.valueType)
      assertEquals(7L, update.sequenceNumber)
    }
  }

  @Test
  fun `uses the device-side event timestamp rather than the frame timestamp`() = runTest {
    val client = ObservationStreamClient()

    client.storageUpdates.test {
      client.handleMessage(storageFrame())

      // 1234 is when the change happened on device; 9999 is when the daemon relayed it.
      assertEquals(1234L, awaitItem().timestamp)
    }
  }

  @Test
  fun `a null key marks the frame as a whole-file clear`() = runTest {
    val client = ObservationStreamClient()

    client.storageUpdates.test {
      client.handleMessage(storageFrame(key = null, value = null))

      val update = awaitItem()
      assertNull(update.key)
      assertTrue(update.isFileCleared)
    }
  }

  @Test
  fun `a null value with a key is a delete, not a clear`() = runTest {
    val client = ObservationStreamClient()

    client.storageUpdates.test {
      client.handleMessage(storageFrame(value = null))

      val update = awaitItem()
      assertEquals("theme", update.key)
      assertNull(update.value)
      assertTrue(!update.isFileCleared)
    }
  }

  @Test
  fun `an unrecognized value type degrades to Unknown`() = runTest {
    val client = ObservationStreamClient()

    client.storageUpdates.test {
      // iOS emits DICTIONARY, which the desktop enum has no member for.
      client.handleMessage(storageFrame(valueType = "DICTIONARY"))

      assertEquals(KeyValueType.Unknown, awaitItem().valueType)
    }
  }

  @Test
  fun `a storage_update without a payload is ignored rather than crashing`() = runTest {
    val client = ObservationStreamClient()

    client.storageUpdates.test {
      client.handleMessage("""{"type":"storage_update","deviceId":"emulator-5554"}""")

      expectNoEvents()
    }
  }

  @Test
  fun `a slow storage collector does not block the multiplexed frame reader`() = runTest {
    val client = ObservationStreamClient()
    val firstUpdateStarted = CompletableDeferred<Unit>()
    val collector = launch {
      client.storageUpdates.collect {
        firstUpdateStarted.complete(Unit)
        awaitCancellation()
      }
    }
    try {
      client.handleMessage(storageFrame())
      firstUpdateStarted.await()

      // The dedicated delivery coroutine is now blocked on the slow collector. Additional
      // storage frames must still enqueue immediately so the socket loop can process pings and
      // hierarchy/screenshot frames.
      withTimeout(1_000) {
        repeat(100) { index ->
          client.handleMessage(storageFrame(key = "\"key-$index\"", value = "\"$index\""))
        }
      }
    } finally {
      collector.cancel()
      client.dispose()
    }
  }

  @Test
  fun `request_observation carries the device id and no cadence fields`() {
    val request =
      StreamRequest(
        id = "req-1",
        command = "request_observation",
        deviceId = "emulator-5554",
      )

    val encoded = wireJson.encodeToString(StreamRequest.serializer(), request)

    assertTrue(encoded.contains("\"command\":\"request_observation\""), encoded)
    assertTrue(encoded.contains("\"deviceId\":\"emulator-5554\""), encoded)
    // A one-shot capture must not disturb the subscription's cadence.
    assertTrue(!encoded.contains("screenshotIntervalMs"), encoded)
    assertTrue(!encoded.contains("hierarchyIntervalMs"), encoded)
  }

  @Test
  fun `request_observation omits the device id when capturing every device`() {
    val request = StreamRequest(id = "req-1", command = "request_observation", deviceId = null)

    val encoded = wireJson.encodeToString(StreamRequest.serializer(), request)

    assertTrue(!encoded.contains("deviceId"), encoded)
  }

  @Test
  fun `requestObservation is a no-op while disconnected`() {
    val client = ObservationStreamClient()

    // Must not throw despite there being no socket; the daemon may not be running.
    client.requestObservation("emulator-5554")
  }

  @Test
  fun `subscribe_storage command serializes the epoch, package, and file`() {
    val request =
      StreamRequest(
        id = "s-1",
        command = "subscribe_storage",
        deviceId = "emulator-5554",
        deviceSessionUuid = "epoch-a",
        packageName = "com.example",
        fileName = "prefs.xml",
      )

    val encoded = wireJson.encodeToString(StreamRequest.serializer(), request)

    assertTrue(encoded.contains("\"command\":\"subscribe_storage\""), encoded)
    assertTrue(encoded.contains("\"deviceSessionUuid\":\"epoch-a\""), encoded)
    assertTrue(encoded.contains("\"packageName\":\"com.example\""), encoded)
    assertTrue(encoded.contains("\"fileName\":\"prefs.xml\""), encoded)
  }

  @Test
  fun `subscribeStorage sends a subscribe_storage command carrying the device, package, and file`() {
    withConnectedClient { client, factory ->
      client.subscribeStorage("com.example", "prefs.xml")

      val req = factory.opened.single().sentRequests().single { it.command == "subscribe_storage" }
      assertEquals("emulator-5554", req.deviceId)
      assertEquals("com.example", req.packageName)
      assertEquals("prefs.xml", req.fileName)
    }
  }

  @Test
  fun `subscribing the same file twice sends only one subscribe_storage`() {
    withConnectedClient { client, factory ->
      client.subscribeStorage("com.example", "prefs.xml")
      client.subscribeStorage("com.example", "prefs.xml")

      val count =
        factory.opened.single().sentRequests().count {
          it.command == "subscribe_storage" && it.fileName == "prefs.xml"
        }
      assertEquals(1, count)
    }
  }

  @Test
  fun `remembered storage subscriptions are re-applied with the epoch on reconnect`() {
    withConnectedClient { client, factory ->
      client.subscribeStorage("com.example", "prefs.xml")
      client.disconnect()
      client.connect("emulator-5554", "epoch-a")

      // A reconnect must re-register the device-side observer, or live updates die silently
      // (#4709).
      val second = factory.opened[1].sentRequests()
      val replay = second.single { it.command == "subscribe_storage" && it.fileName == "prefs.xml" }
      assertEquals("epoch-a", replay.deviceSessionUuid)
    }
  }

  @Test
  fun `unsubscribeStorage sends unsubscribe_storage and stops re-applying on reconnect`() {
    withConnectedClient { client, factory ->
      client.subscribeStorage("com.example", "prefs.xml")
      val subscribe =
        factory.opened.single().sentRequests().single { it.command == "subscribe_storage" }
      client.handleMessage(
        """{"id":"${subscribe.id}","type":"subscription_response","success":true}"""
      )
      client.unsubscribeStorage("com.example", "prefs.xml")

      val first = factory.opened[0].sentRequests()
      assertTrue(
        first.any { it.command == "unsubscribe_storage" && it.fileName == "prefs.xml" },
        first.toString(),
      )

      client.disconnect()
      client.connect("emulator-5554")
      val second = factory.opened[1].sentRequests()
      assertTrue(
        second.none { it.command == "subscribe_storage" && it.fileName == "prefs.xml" },
        second.toString(),
      )
    }
  }

  @Test
  fun `storage acknowledgement is correlated to its request id`() {
    withConnectedClient { client, factory ->
      client.storageSubscriptionResponses.test {
        client.subscribeStorage("com.example", "prefs.xml")
        val request =
          factory.opened.single().sentRequests().single { it.command == "subscribe_storage" }

        client.handleMessage(
          """{"id":"${request.id}","type":"subscription_response","success":true}"""
        )

        assertEquals(
          StorageSubscriptionResponse(
            requestId = request.id,
            key = StorageSubscriptionKey("com.example", "prefs.xml"),
            subscribe = true,
            success = true,
          ),
          awaitItem(),
        )
      }
    }
  }

  @Test
  fun `unsubscribe waits for an in-flight subscribe acknowledgement`() {
    withConnectedClient { client, factory ->
      client.subscribeStorage("com.example", "prefs.xml")
      val transport = factory.opened.single()
      val subscribe = transport.sentRequests().single { it.command == "subscribe_storage" }

      // The observer may not exist yet, so do not send an unsubscribe that can race it.
      client.unsubscribeStorage("com.example", "prefs.xml")
      assertEquals(1, transport.sentRequests().count { it.command.endsWith("storage") })

      client.handleMessage(
        """{"id":"${subscribe.id}","type":"subscription_response","success":true}"""
      )

      val unsubscribe = transport.sentRequests().single { it.command == "unsubscribe_storage" }
      client.handleMessage(
        """{"id":"${unsubscribe.id}","type":"subscription_response","success":true}"""
      )
      assertEquals(2, transport.sentRequests().count { it.command.endsWith("storage") })
    }
  }

  @Test
  fun `a failed storage subscribe is reported without confirmation`() {
    withConnectedClient { client, factory ->
      client.storageSubscriptionResponses.test {
        client.subscribeStorage("com.example", "prefs.xml")
        val request =
          factory.opened.single().sentRequests().single { it.command == "subscribe_storage" }

        client.handleMessage(
          """{"id":"${request.id}","type":"error","success":false,"error":"runner unavailable"}"""
        )

        val response = awaitItem()
        assertEquals(false, response.success)
        assertEquals("runner unavailable", response.error)
        assertEquals(request.id, response.requestId)
        // A permanent rejection must not be redriven in a tight request/error loop.
        assertEquals(
          1,
          factory.opened.single().sentRequests().count { it.command == "subscribe_storage" },
        )
      }
    }
  }

  @Test
  fun `an intent change during a failed unsubscribe sends a compensating subscribe`() {
    withConnectedClient { client, factory ->
      val transport = factory.opened.single()
      client.subscribeStorage("com.example", "prefs.xml")
      val initialSubscribe = transport.sentRequests().single { it.command == "subscribe_storage" }
      client.handleMessage(
        """{"id":"${initialSubscribe.id}","type":"subscription_response","success":true}"""
      )

      client.unsubscribeStorage("com.example", "prefs.xml")
      val unsubscribe = transport.sentRequests().single { it.command == "unsubscribe_storage" }
      client.subscribeStorage("com.example", "prefs.xml")

      // The runner may have applied the unsubscribe before its response failed. The newer desired
      // state therefore needs an explicit subscribe instead of trusting the old confirmation.
      client.handleMessage(
        """{"id":"${unsubscribe.id}","type":"error","success":false,"error":"response lost"}"""
      )

      assertEquals(
        2,
        transport.sentRequests().count { it.command == "subscribe_storage" },
      )
    }
  }

  @Test
  fun `retains every acknowledgement received before collection starts`() {
    withConnectedClient { client, factory ->
      client.subscribeStorage("com.example", "first.xml")
      client.subscribeStorage("com.example", "second.xml")
      val requests =
        factory.opened.single().sentRequests().filter { it.command == "subscribe_storage" }

      // DisposableEffect can issue both commands before a later LaunchedEffect starts collecting.
      // The acknowledgements must remain correlated one-for-one, not collapse to replay=1.
      client.handleMessage(
        """{"id":"${requests[0].id}","type":"subscription_response","success":true}"""
      )
      client.handleMessage(
        """{"id":"${requests[1].id}","type":"subscription_response","success":true}"""
      )

      client.storageSubscriptionResponses.test {
        assertEquals(requests[0].id, awaitItem().requestId)
        assertEquals(requests[1].id, awaitItem().requestId)
      }
    }
  }

  @Test
  fun `a late storage acknowledgement after disconnect is ignored`() {
    withConnectedClient { client, factory ->
      client.subscribeStorage("com.example", "prefs.xml")
      val request =
        factory.opened.single().sentRequests().single { it.command == "subscribe_storage" }
      client.disconnect()

      client.storageSubscriptionResponses.test {
        client.handleMessage(
          """{"id":"${request.id}","type":"subscription_response","success":true}"""
        )
        expectNoEvents()
      }
    }
  }

  /**
   * Runs [block] against a client connected (device "emulator-5554") over a [CapturingTransport],
   * so a test can assert exactly which commands were written to the wire. The parked reader keeps
   * the connection in Connected state until [ObservationStreamClient.dispose], which is always
   * called.
   */
  private fun withConnectedClient(
    block: suspend (ObservationStreamClient, CapturingTransportFactory) -> Unit
  ) = runBlocking {
    // connect() gates on Files.exists(socketPath); a real temp file passes it while the fake
    // factory
    // ignores the path entirely.
    val socket = Files.createTempFile("obs-storage-seam", ".sock")
    try {
      val factory = CapturingTransportFactory()
      val client =
        ObservationStreamClient(
          transportFactory = factory,
          socketPathProvider = { socket.toString() },
        )
      client.connect("emulator-5554")
      try {
        block(client, factory)
      } finally {
        client.dispose()
      }
    } finally {
      Files.deleteIfExists(socket)
    }
  }

  private class CapturingTransportFactory : ObservationStreamTransportFactory {
    val opened = mutableListOf<CapturingTransport>()

    override fun open(socketPath: String): ObservationStreamTransport =
      CapturingTransport().also { opened += it }
  }

  /**
   * In-memory transport that retains every line written so a test can parse the sent
   * [StreamRequest]s.
   */
  private class CapturingTransport : ObservationStreamTransport {
    private val sink = StringWriter()
    private val parkedReader = ParkedReader()
    override val reader: BufferedReader = BufferedReader(parkedReader)
    override val writer: BufferedWriter = BufferedWriter(sink)

    override fun close() = parkedReader.release()

    fun sentRequests(): List<StreamRequest> =
      sink
        .toString()
        .split("\n")
        .filter { it.isNotBlank() }
        .map { decodeJson.decodeFromString(StreamRequest.serializer(), it) }

    companion object {
      private val decodeJson = Json { ignoreUnknownKeys = true }
    }
  }

  /**
   * Blocks its single read until [close] (via [release]), keeping the read loop -- and Connected --
   * alive.
   */
  private class ParkedReader : java.io.Reader() {
    private val gate = java.util.concurrent.CountDownLatch(1)

    fun release() = gate.countDown()

    override fun read(cbuf: CharArray, off: Int, len: Int): Int {
      gate.await(5, java.util.concurrent.TimeUnit.SECONDS)
      return -1
    }

    override fun close() = Unit
  }
}
