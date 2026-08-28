package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.ui.graphics.ImageBitmap
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.McpResourceContent
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class NavigationScreenshotLoaderTest {

  @Test
  fun `load returns null when clientProvider is null`() = runBlocking {
    val loader =
      NavigationScreenshotLoader(
        clientProvider = null,
        imageDecoder = FakeImageDecoder(),
      )

    val result = loader.load("automobile:navigation/nodes/123/screenshot")

    assertNull(result)
  }

  @Test
  fun `load returns cached bitmap on second call`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponse("automobile:navigation/nodes/123/screenshot", SMALL_PNG_BASE64)

    val loader =
      NavigationScreenshotLoader(
        clientProvider = { client },
        imageDecoder = FakeImageDecoder(),
      )

    // First call - should fetch from client
    val first = loader.load("automobile:navigation/nodes/123/screenshot")
    assertNotNull(first)
    assertEquals(1, client.readResourceCallCount)

    // Second call - should use cache, not call client again
    val second = loader.load("automobile:navigation/nodes/123/screenshot")
    assertNotNull(second)
    assertEquals(1, client.readResourceCallCount) // Still 1, cache hit
  }

  @Test
  fun `load caches results and respects maxCacheSize LRU eviction`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponse("uri1", SMALL_PNG_BASE64)
    client.setResourceResponse("uri2", SMALL_PNG_BASE64)
    client.setResourceResponse("uri3", SMALL_PNG_BASE64)

    val loader =
      NavigationScreenshotLoader(
        clientProvider = { client },
        maxCacheSize = 2,
        imageDecoder = FakeImageDecoder(),
      )

    // Load three URIs with cache size of 2
    loader.load("uri1")
    loader.load("uri2")
    loader.load("uri3") // This should evict uri1

    assertEquals(3, client.readResourceCallCount)
    assertEquals(2, loader.cacheSize())

    // Access uri2 and uri3 - should be cached
    loader.load("uri2")
    loader.load("uri3")
    assertEquals(3, client.readResourceCallCount) // Still 3, cache hits

    // Access uri1 - should require fetch (was evicted)
    loader.load("uri1")
    assertEquals(4, client.readResourceCallCount) // Now 4, cache miss
  }

  @Test
  fun `load evicts LRU entries when byte limit is exceeded`() = runBlocking {
    val client = FakeAutoMobileClient()
    // Use unique base64 blobs so FakeImageDecoder creates distinct bitmaps per URI
    client.setResourceResponse("uri1", SMALL_PNG_BASE64)
    client.setResourceResponse("uri2", SMALL_PNG_BASE64_ALT)
    client.setResourceResponse("uri3", SMALL_PNG_BASE64)

    // Each 100x100 image = 100*100*4 = 40,000 bytes
    // Set byte limit to 79,999 so only 1 image fits (2 would be 80,000)
    val decoder = FakeImageDecoder(bitmapWidth = 100, bitmapHeight = 100)
    val loader =
      NavigationScreenshotLoader(
        clientProvider = { client },
        maxCacheSize = 50, // Count limit won't trigger
        maxCacheBytes = 79_999L,
        imageDecoder = decoder,
      )

    loader.load("uri1")
    assertEquals(1, loader.cacheSize())

    // Loading uri2 should evict uri1 since 2 images exceed byte limit
    loader.load("uri2")
    assertEquals(1, loader.cacheSize())

    // uri1 should have been evicted, requiring a re-fetch
    loader.load("uri1")
    assertEquals(3, client.readResourceCallCount) // 1 + 1 + 1 (cache miss on uri1)
  }

  @Test
  fun `clearCache resets byte tracking`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponse("uri1", SMALL_PNG_BASE64)
    client.setResourceResponse("uri2", SMALL_PNG_BASE64_ALT)

    // Each 100x100 image = 40,000 bytes, byte limit allows 2
    val decoder = FakeImageDecoder(bitmapWidth = 100, bitmapHeight = 100)
    val loader =
      NavigationScreenshotLoader(
        clientProvider = { client },
        maxCacheSize = 50,
        maxCacheBytes = 80_000L,
        imageDecoder = decoder,
      )

    loader.load("uri1")
    loader.load("uri2")
    assertEquals(2, loader.cacheSize())

    loader.clearCache()
    assertEquals(0, loader.cacheSize())

    // After clear, both should fit again without eviction
    loader.load("uri1")
    loader.load("uri2")
    assertEquals(2, loader.cacheSize())
    assertEquals(4, client.readResourceCallCount)
  }

  @Test
  fun `load returns null when client throws McpConnectionException`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.throwOnReadResource = McpConnectionException("Connection failed")

    val loader =
      NavigationScreenshotLoader(
        clientProvider = { client },
        imageDecoder = FakeImageDecoder(),
      )

    val result = loader.load("automobile:navigation/nodes/123/screenshot")

    assertNull(result)
    assertEquals(1, client.readResourceCallCount)
  }

  @Test
  fun `load returns null when resource has no blob content`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponseWithText(
      "automobile:navigation/nodes/123/screenshot",
      "text content only",
    )

    val loader =
      NavigationScreenshotLoader(
        clientProvider = { client },
        imageDecoder = FakeImageDecoder(),
      )

    val result = loader.load("automobile:navigation/nodes/123/screenshot")

    assertNull(result)
  }

  @Test
  fun `invalidate removes entry from cache`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponse("automobile:navigation/nodes/123/screenshot", SMALL_PNG_BASE64)

    val loader =
      NavigationScreenshotLoader(
        clientProvider = { client },
        imageDecoder = FakeImageDecoder(),
      )

    // Load to populate cache
    loader.load("automobile:navigation/nodes/123/screenshot")
    assertEquals(1, client.readResourceCallCount)
    assertEquals(1, loader.cacheSize())

    // Invalidate
    loader.invalidate("automobile:navigation/nodes/123/screenshot")
    assertEquals(0, loader.cacheSize())

    // Load again - should fetch from client
    loader.load("automobile:navigation/nodes/123/screenshot")
    assertEquals(2, client.readResourceCallCount)
  }

  @Test
  fun `clearCache removes all entries`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponse("uri1", SMALL_PNG_BASE64)
    client.setResourceResponse("uri2", SMALL_PNG_BASE64)

    val loader =
      NavigationScreenshotLoader(
        clientProvider = { client },
        imageDecoder = FakeImageDecoder(),
      )

    // Load multiple entries
    loader.load("uri1")
    loader.load("uri2")
    assertEquals(2, loader.cacheSize())

    // Clear cache
    loader.clearCache()
    assertEquals(0, loader.cacheSize())

    // Load again - should fetch from client
    loader.load("uri1")
    loader.load("uri2")
    assertEquals(4, client.readResourceCallCount) // 2 original + 2 after clear
  }

  @Test
  fun `load does not cache bitmap larger than maxCacheBytes`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponse("uri1", SMALL_PNG_BASE64)

    // 200x200x4 = 160,000 bytes per image; set limit below that
    val decoder = FakeImageDecoder(bitmapWidth = 200, bitmapHeight = 200)
    val loader =
      NavigationScreenshotLoader(
        clientProvider = { client },
        maxCacheSize = 50,
        maxCacheBytes = 100_000L, // Less than a single 200x200 image
        imageDecoder = decoder,
      )

    // Load should succeed (returns bitmap) but not cache it
    val result = loader.load("uri1")
    assertNotNull(result)
    assertEquals(0, loader.cacheSize())

    // Second load should fetch again since nothing was cached
    loader.load("uri1")
    assertEquals(2, client.readResourceCallCount)
  }

  @Test
  fun `duplicate URI load does not inflate byte tracking`() = runBlocking {
    val client = FakeAutoMobileClient()
    client.setResourceResponse("uri1", SMALL_PNG_BASE64)
    client.setResourceResponse("uri2", SMALL_PNG_BASE64_ALT)

    // Each 100x100 image = 40,000 bytes; limit fits exactly 2
    val decoder = FakeImageDecoder(bitmapWidth = 100, bitmapHeight = 100)
    val loader =
      NavigationScreenshotLoader(
        clientProvider = { client },
        maxCacheSize = 50,
        maxCacheBytes = 80_000L,
        imageDecoder = decoder,
      )

    loader.load("uri1")
    assertEquals(1, loader.cacheSize())

    // Invalidate so uri1 is not in cache, then reload to trigger addToCache again
    loader.invalidate("uri1")
    loader.load("uri1")
    assertEquals(1, loader.cacheSize())

    // If byte tracking is correct, uri2 should still fit (40k + 40k = 80k <= 80k)
    loader.load("uri2")
    assertEquals(2, loader.cacheSize())
  }

  companion object {
    // Minimal valid PNG base64 - only used to simulate blob content
    private const val SMALL_PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    private const val SMALL_PNG_BASE64_ALT =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="
  }
}

/**
 * Fake ImageDecoder for testing that returns a mock ImageBitmap without Skia dependencies. Creates
 * a unique bitmap per byte array content for identity checks.
 */
class FakeImageDecoder(
  private val bitmapWidth: Int = 1,
  private val bitmapHeight: Int = 1,
) : ImageDecoder {
  private val bitmapCache = mutableMapOf<String, ImageBitmap>()

  override fun decode(bytes: ByteArray): ImageBitmap {
    // Create a cache key from bytes to return consistent bitmaps for same content
    val key = bytes.contentHashCode().toString()
    return bitmapCache.getOrPut(key) { FakeImageBitmap(bitmapWidth, bitmapHeight) }
  }
}

/**
 * Minimal fake ImageBitmap for testing. Uses a stub implementation since tests only need
 * identity/null checks.
 */
class FakeImageBitmap(
  override val width: Int = 1,
  override val height: Int = 1,
) : ImageBitmap {
  override val colorSpace
    get() = throw NotImplementedError("Stub")

  override val config
    get() = throw NotImplementedError("Stub")

  override val hasAlpha
    get() = true

  override fun prepareToDraw() {}

  override fun readPixels(
    buffer: IntArray,
    startX: Int,
    startY: Int,
    width: Int,
    height: Int,
    bufferOffset: Int,
    stride: Int,
  ) {}
}

/**
 * Fake implementation of AutoMobileClient for testing NavigationScreenshotLoader. Only implements
 * readResource() as that's the only method used by the loader.
 */
class FakeAutoMobileClient : AutoMobileClient {
  private val resourceResponses = mutableMapOf<String, McpResourceContent>()
  var throwOnReadResource: McpConnectionException? = null
  var readResourceCallCount = 0
    private set

  override val transportName: String = "fake"
  override val connectionDescription: String = "Fake client for testing"

  fun setResourceResponse(uri: String, blobBase64: String) {
    resourceResponses[uri] =
      McpResourceContent(
        uri = uri,
        mimeType = "image/png",
        blob = blobBase64,
      )
  }

  fun setResourceResponseWithText(uri: String, text: String) {
    resourceResponses[uri] =
      McpResourceContent(
        uri = uri,
        mimeType = "text/plain",
        text = text,
      )
  }

  override fun readResource(uri: String): List<McpResourceContent> {
    readResourceCallCount++
    throwOnReadResource?.let { throw it }
    return listOfNotNull(resourceResponses[uri])
  }

  // Unused methods - throw to ensure they're not called unexpectedly
  override fun ping() = notImplemented()

  override fun listResources() = notImplemented()

  override fun listResourceTemplates() = notImplemented()

  override fun listTools() = notImplemented()

  override fun getNavigationGraph(platform: String) = notImplemented()

  override fun listFeatureFlags() = notImplemented()

  override fun setFeatureFlag(
    key: String,
    enabled: Boolean,
    config: kotlinx.serialization.json.JsonObject?,
  ) = notImplemented()

  override fun listPerformanceAuditResults(
    startTime: String?,
    endTime: String?,
    limit: Int?,
    offset: Int?,
    deviceId: String?,
  ) = notImplemented()

  override fun getTestTimings(
    query: dev.jasonpearson.automobile.desktop.core.daemon.TestTimingQuery
  ) = notImplemented()

  override fun startTestRecording(platform: String) = notImplemented()

  override fun stopTestRecording(recordingId: String?, planName: String?) = notImplemented()

  override fun executePlan(
    planContent: String,
    platform: String,
    startStep: Int?,
    sessionUuid: String?,
  ) = notImplemented()

  override fun startDevice(name: String, platform: String, deviceId: String?) = notImplemented()

  override fun setActiveDevice(deviceId: String, platform: String) = notImplemented()

  override fun getTestRuns(query: dev.jasonpearson.automobile.desktop.core.daemon.TestRunQuery) =
    notImplemented()

  override fun observe(platform: String) = notImplemented()

  override fun killDevice(name: String, deviceId: String, platform: String) = notImplemented()

  override fun getDaemonStatus() = notImplemented()

  override fun updateService(deviceId: String, platform: String) = notImplemented()

  override fun inputTap(
    x: Double,
    y: Double,
    platform: String,
    deviceId: String?,
    duration: Int?,
    frameContext: String?,
  ) = notImplemented()

  override fun inputSwipe(
    startX: Double,
    startY: Double,
    endX: Double,
    endY: Double,
    platform: String,
    deviceId: String?,
    durationMs: Int?,
    frameContext: String?,
  ) = notImplemented()

  override fun inputPressButton(
    button: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ) = notImplemented()

  override fun inputTypeText(
    text: String,
    platform: String,
    deviceId: String?,
    submit: Boolean?,
    append: Boolean,
    frameContext: String?,
  ) = notImplemented()

  override fun inputKey(
    key: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ) = notImplemented()

  override fun setKeyValue(
    deviceId: String,
    appId: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
    platform: String,
  ) = notImplemented()

  override fun removeKeyValue(
    deviceId: String,
    appId: String,
    fileName: String,
    key: String,
    platform: String,
  ) = notImplemented()

  override fun clearKeyValueFile(
    deviceId: String,
    appId: String,
    fileName: String,
    platform: String,
  ) = notImplemented()

  override fun callTool(name: String, arguments: kotlinx.serialization.json.JsonObject) =
    notImplemented()

  private fun notImplemented(): Nothing =
    throw NotImplementedError("FakeAutoMobileClient: method not implemented for testing")
}
