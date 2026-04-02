package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import dev.jasonpearson.automobile.sdk.events.SdkEventBuffer
import java.util.concurrent.Executors
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.After
import org.junit.Test

class AutoMobileNetworkTest {

    @After
    fun tearDown() {
        AutoMobileNetwork.reset()
    }

    private fun collectingBuffer(): Pair<SdkEventBuffer, MutableList<List<SdkEvent>>> {
        val flushed = mutableListOf<List<SdkEvent>>()
        val buffer = SdkEventBuffer(
            maxBufferSize = 1,
            flushIntervalMs = 60_000,
            onFlush = { flushed.add(it) },
            executor = Executors.newSingleThreadScheduledExecutor(),
        )
        return buffer to flushed
    }

    @Test
    fun `recordRequest records event with all fields`() {
        val (buffer, flushed) = collectingBuffer()
        AutoMobileNetwork.initialize("com.example", buffer)

        AutoMobileNetwork.recordRequest(NetworkRequestRecord(
            url = "https://api.example.com/users?page=1",
            method = "GET",
            statusCode = 200,
            durationMs = 42,
            responseBodySize = 1024,
            host = "api.example.com",
            path = "/users",
        ))
        buffer.flush()

        assertEquals(1, flushed.size)
        val event = flushed[0][0] as SdkNetworkRequestEvent
        assertEquals("https://api.example.com/users?page=1", event.url)
        assertEquals("GET", event.method)
        assertEquals(200, event.statusCode)
        assertEquals(42L, event.durationMs)
        assertEquals(1024L, event.responseBodySize)
        assertEquals("api.example.com", event.host)
        assertEquals("/users", event.path)
        assertEquals("com.example", event.applicationId)
        assertNull(event.error)
    }

    @Test
    fun `recordRequest extracts host and path from URL when not provided`() {
        val (buffer, flushed) = collectingBuffer()
        AutoMobileNetwork.initialize("com.example", buffer)

        AutoMobileNetwork.recordRequest(NetworkRequestRecord(
            url = "https://api.example.com/v2/items",
            method = "POST",
        ))
        buffer.flush()

        val event = flushed[0][0] as SdkNetworkRequestEvent
        assertEquals("api.example.com", event.host)
        assertEquals("/v2/items", event.path)
    }

    @Test
    fun `recordRequest is no-op when not initialized`() {
        // buffer is null — should not throw
        AutoMobileNetwork.recordRequest(NetworkRequestRecord(
            url = "https://example.com",
            method = "GET",
        ))
    }

    @Test
    fun `NetworkRequestRecord defaults`() {
        val record = NetworkRequestRecord(url = "https://example.com", method = "GET")
        assertNull(record.requestHeaders)
        assertEquals(-1L, record.requestBodySize)
        assertEquals(0, record.statusCode)
        assertNull(record.responseHeaders)
        assertEquals(-1L, record.responseBodySize)
        assertEquals(0L, record.durationMs)
        assertNull(record.error)
        assertNull(record.host)
        assertNull(record.path)
        assertNull(record.requestBody)
        assertNull(record.responseBody)
        assertNull(record.contentType)
    }
}
