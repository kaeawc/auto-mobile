package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeRemoteImageCounts
import dev.jasonpearson.automobile.protocol.PrototypeRemoteImages
import dev.jasonpearson.automobile.prototype.BuildConfig
import java.io.IOException
import java.net.URI
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

/**
 * Host-owned transport: bounded bytes, validated redirects and the request transport's egress
 * policy.
 */
@InternalAutoMobilePrototypeApi
fun interface PrototypeRemoteImageTransport {
  suspend fun download(url: String): ByteArray
}

/** Optional image support on an embedded device transport; the host owns network enablement. */
@InternalAutoMobilePrototypeApi
interface PrototypeRemoteImageProvider {
  val remoteImages: PrototypeRemoteImageLoader?
}

/** A silent image load. URLs are private inputs, never diagnostic or accessibility output. */
@InternalAutoMobilePrototypeApi
fun interface PrototypeRemoteImageLoader {
  suspend fun load(url: String, target: PrototypeImageTarget): PrototypeImageState
}

/**
 * Shared by all surfaces in an app; the permit covers fetching and decoding, including cache hits.
 */
@InternalAutoMobilePrototypeApi
class LimitedPrototypeRemoteImageLoader(private val delegate: PrototypeRemoteImageLoader) :
  PrototypeRemoteImageLoader {
  private val permits = Semaphore(PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_LOADS)

  override suspend fun load(url: String, target: PrototypeImageTarget): PrototypeImageState =
    permits.withPermit {
      delegate.load(url, target)
    }
}

/** URL-keyed encoded disk storage and the asset renderer's sampled, bounded bitmap cache. */
@InternalAutoMobilePrototypeApi
class CachedPrototypeRemoteImageLoader(
  private val transport: PrototypeRemoteImageTransport,
  private val store: PrototypeRemoteImageStore,
  decoder: PrototypeImageDecoder,
  maxDecodedBytes: Long =
    Runtime.getRuntime().maxMemory() /
      PrototypeRemoteImages.PROTOTYPE_REMOTE_IMAGE_ANDROID_HEAP_DIVISOR,
  private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) : PrototypeRemoteImageLoader {
  private val cache = PrototypeImageCache(store, decoder, maxDecodedBytes, dispatcher)
  private val limited = LimitedPrototypeRemoteImageLoader { url, target ->
    withContext(dispatcher) {
      if (!prototypeRemoteImageUrlAllowed(url, BuildConfig.DEBUG)) PrototypeImageState.Missing
      else {
        cache.peek(url, target)?.takeIf { it is PrototypeImageState.Ready }
          ?: loadUncached(url, target)
      }
    }
  }

  override suspend fun load(url: String, target: PrototypeImageTarget): PrototypeImageState =
    loadPrototypeRemoteImage(limited, url, target)

  private suspend fun loadUncached(url: String, target: PrototypeImageTarget): PrototypeImageState {
    if (store.lookup(url) == null) {
      val bytes = transport.download(url)
      if (
        bytes.isEmpty() ||
          bytes.size > PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES
      )
        return PrototypeImageState.Missing
      store.put(url, bytes)
    }
    return cache.load(url, target)
  }
}

/** One entry per mounted image instance; never stores a URL, asset id or error message. */
@InternalAutoMobilePrototypeApi
class PrototypeRemoteImageActivity {
  private val states = mutableMapOf<Any, String>()

  @Synchronized
  fun set(identity: Any, state: PrototypeImageState) {
    states[identity] = prototypeRemoteImageDescription(state)
  }

  @Synchronized
  fun remove(identity: Any) {
    states.remove(identity)
  }

  @Synchronized
  fun counts(): PrototypeRemoteImageCounts =
    PrototypeRemoteImageCounts(
      loaded = states.values.count { it == "loaded" },
      failed = states.values.count { it == "error" },
      pending = states.values.count { it == "loading" },
    )
}

internal fun prototypeRemoteImageDescription(state: PrototypeImageState): String =
  when (state) {
    PrototypeImageState.Loading -> "loading"
    is PrototypeImageState.Ready -> "loaded"
    else -> "error"
  }

/**
 * A failing loader is deliberately silent, including errors carrying a URL from a host transport.
 */
internal suspend fun loadPrototypeRemoteImage(
  loader: PrototypeRemoteImageLoader?,
  url: String,
  target: PrototypeImageTarget,
): PrototypeImageState =
  try {
    loader?.load(url, target) ?: PrototypeImageState.Missing
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (_: IOException) {
    PrototypeImageState.Missing
  } catch (_: IllegalArgumentException) {
    PrototypeImageState.Missing
  } catch (_: SecurityException) {
    PrototypeImageState.Missing
  }

/** Validate resolved bindings before transport or cache access; local URI schemes are refused. */
@InternalAutoMobilePrototypeApi
fun prototypeRemoteImageUrlAllowed(url: String, allowLoopback: Boolean): Boolean {
  if (
    url.length !in 1..PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_URL_LENGTH ||
      url.hasInvalidImageUrlCharacters()
  )
    return false
  val uri =
    try {
      java.net.URI(url)
    } catch (_: java.net.URISyntaxException) {
      return false
    }
  if (uri.hasInvalidImageAuthority()) return false
  return uri.scheme.equals("https", true) || (allowLoopback && uri.isLoopbackHttpImageUrl())
}

private fun String.hasInvalidImageUrlCharacters(): Boolean = any {
  it.isWhitespace() || it.isISOControl() || it == '\\'
}

private fun URI.hasInvalidImageAuthority(): Boolean =
  rawUserInfo != null || host == null || hasInvalidImagePort()

private fun URI.hasInvalidImagePort(): Boolean = port !in -1..65535 || port == 0

private fun URI.isLoopbackHttpImageUrl(): Boolean =
  scheme.equals("http", true) && host.lowercase() in setOf("localhost", "127.0.0.1", "[::1]")

/** The renderer and fake-only tests use the same state/count lifecycle. */
internal class PrototypeRemoteImageSession(private val activity: PrototypeRemoteImageActivity?) {
  private val identity = Any()
  private val current =
    kotlinx.coroutines.flow.MutableStateFlow<PrototypeImageState>(PrototypeImageState.Loading)
  val state: kotlinx.coroutines.flow.StateFlow<PrototypeImageState> = current
  private var closed = false

  suspend fun load(loader: PrototypeRemoteImageLoader?, url: String, target: PrototypeImageTarget) {
    update(PrototypeImageState.Loading)
    try {
      update(loadPrototypeRemoteImage(loader, url, target))
    } catch (cancelled: CancellationException) {
      close()
      throw cancelled
    }
  }

  private fun update(value: PrototypeImageState) {
    if (!closed) {
      current.value = value
      activity?.set(identity, value)
    }
  }

  fun close() {
    closed = true
    activity?.remove(identity)
  }
}
