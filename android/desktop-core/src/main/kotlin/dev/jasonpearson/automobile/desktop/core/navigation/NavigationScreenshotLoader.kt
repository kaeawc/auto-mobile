package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import org.jetbrains.skia.Image

/** Interface for loading screenshot images from URIs. */
interface ScreenshotLoader {
  suspend fun load(uri: String): ImageBitmap?

  fun invalidate(uri: String)

  fun clearCache()

  fun cacheSize(): Int
}

/**
 * Interface for decoding bytes into ImageBitmap. Extracted for testability since Skia native
 * libraries aren't available in unit tests.
 */
fun interface ImageDecoder {
  fun decode(bytes: ByteArray): ImageBitmap
}

/** Default implementation using Skia for production use. */
object SkiaImageDecoder : ImageDecoder {
  override fun decode(bytes: ByteArray): ImageBitmap {
    val skiaImage = Image.makeFromEncoded(bytes)
    return skiaImage.toComposeImageBitmap()
  }
}

/**
 * Fake implementation of ScreenshotLoader for testing. Stores images in memory and tracks load
 * calls without making network requests.
 */
class FakeScreenshotLoader : ScreenshotLoader {
  private val images = mutableMapOf<String, ImageBitmap>()
  private val loadCalls = mutableListOf<String>()

  fun setImage(uri: String, bitmap: ImageBitmap) {
    images[uri] = bitmap
  }

  fun getLoadCalls(): List<String> = loadCalls.toList()

  override suspend fun load(uri: String): ImageBitmap? {
    loadCalls.add(uri)
    return images[uri]
  }

  override fun invalidate(uri: String) {
    images.remove(uri)
  }

  override fun clearCache() {
    images.clear()
  }

  override fun cacheSize(): Int = images.size
}

/**
 * Session-scoped registry of per-device [NavigationScreenshotLoader]s, held above any facet's
 * composition so a loader's LRU cache survives the facet leaving and re-entering composition (its
 * tool toggled off/on, or Inspect/Input mode swapping the facet out). A body-scoped `remember`
 * would drop the cache on every toggle. Keyed by deviceId so panes for different devices stay
 * isolated.
 */
class NavigationScreenshotLoaderRegistry {
  private val byDevice = ConcurrentHashMap<String, NavigationScreenshotLoader>()

  /** The loader for [deviceId], created once (with [clientProvider]) and reused thereafter. */
  fun forDevice(
    deviceId: String,
    clientProvider: () -> AutoMobileClient,
  ): NavigationScreenshotLoader =
    byDevice.getOrPut(deviceId) { NavigationScreenshotLoader(clientProvider = clientProvider) }

  /** The loader already created for [deviceId], or null if none — lets a test assert wiring. */
  internal fun peek(deviceId: String): NavigationScreenshotLoader? = byDevice[deviceId]
}

/**
 * Process-lifetime default registry backing [NavigationScreenshotLoader] resolution when a facet is
 * not given an explicit provider, so the per-device cache persists for the app session across facet
 * toggles. Tests inject their own registry/provider instead of touching this.
 */
internal val DefaultNavigationScreenshotLoaderRegistry = NavigationScreenshotLoaderRegistry()

/**
 * Loads and caches screenshot thumbnails for navigation graph nodes. Uses an in-memory LRU cache to
 * avoid repeated MCP requests.
 */
class NavigationScreenshotLoader(
  private val clientProvider: (() -> AutoMobileClient)?,
  private val maxCacheSize: Int = 50, // Maximum number of cached images
  private val maxCacheBytes: Long = 100L * 1024 * 1024, // Maximum total byte size (100MB)
  private val imageDecoder: ImageDecoder = SkiaImageDecoder,
) : ScreenshotLoader {
  private val cache = ConcurrentHashMap<String, ImageBitmap>()
  private val entrySizes = mutableMapOf<String, Long>()
  private val accessOrder = mutableListOf<String>() // Track access order for LRU eviction
  private var totalBytes: Long = 0

  /**
   * Load a screenshot from MCP resource URI. Returns cached bitmap if available, otherwise fetches
   * from server.
   *
   * @param uri The MCP resource URI (e.g., "automobile:navigation/nodes/123/screenshot")
   * @return ImageBitmap if successful, null if loading failed or no screenshot available
   */
  override suspend fun load(uri: String): ImageBitmap? {
    // Check cache first
    cache[uri]?.let { bitmap ->
      // Update access order for LRU
      synchronized(accessOrder) {
        accessOrder.remove(uri)
        accessOrder.add(uri)
      }
      return bitmap
    }

    // Fetch from MCP
    val provider = clientProvider ?: return null

    return try {
      val client = provider()
      val contents = client.readResource(uri)
      val content = contents.firstOrNull() ?: return null

      // Check if it's a binary blob (base64 encoded)
      val blob = content.blob ?: return null

      // Decode base64 to bytes
      val bytes = Base64.getDecoder().decode(blob)

      // Convert to ImageBitmap using injected decoder
      val bitmap = imageDecoder.decode(bytes)

      // Add to cache
      addToCache(uri, bitmap)

      bitmap
    } catch (e: McpConnectionException) {
      // MCP not available
      null
    } catch (e: Exception) {
      // Decoding or other error
      null
    }
  }

  private fun addToCache(uri: String, bitmap: ImageBitmap) {
    val estimatedBytes = bitmap.width.toLong() * bitmap.height.toLong() * 4L

    // Skip caching if a single image exceeds the byte limit
    if (estimatedBytes > maxCacheBytes) return

    synchronized(accessOrder) {
      // If URI already exists (race condition), remove old entry first
      val oldSize = entrySizes.remove(uri)
      if (oldSize != null) {
        totalBytes -= oldSize
        accessOrder.remove(uri)
        cache.remove(uri)
      }

      // Evict oldest entries if count limit or byte limit exceeded
      while (
        accessOrder.size >= maxCacheSize ||
          (accessOrder.isNotEmpty() && totalBytes + estimatedBytes > maxCacheBytes)
      ) {
        val oldest = accessOrder.removeFirstOrNull() ?: break
        cache.remove(oldest)
        val removedSize = entrySizes.remove(oldest) ?: 0L
        totalBytes -= removedSize
      }

      cache[uri] = bitmap
      entrySizes[uri] = estimatedBytes
      totalBytes += estimatedBytes
      accessOrder.add(uri)
    }
  }

  /** Invalidate a specific cache entry. */
  override fun invalidate(uri: String) {
    synchronized(accessOrder) {
      cache.remove(uri)
      accessOrder.remove(uri)
      val removedSize = entrySizes.remove(uri) ?: 0L
      totalBytes -= removedSize
    }
  }

  /** Clear the entire cache. */
  override fun clearCache() {
    synchronized(accessOrder) {
      cache.clear()
      accessOrder.clear()
      entrySizes.clear()
      totalBytes = 0
    }
  }

  /** Get the current cache size. */
  override fun cacheSize(): Int = cache.size
}
