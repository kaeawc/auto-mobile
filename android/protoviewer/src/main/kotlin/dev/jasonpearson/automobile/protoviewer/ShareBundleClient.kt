package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeBlockedDestinationException
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeDestinationPolicy
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeEgressInterceptor
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeEgressPolicy
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypePolicyDns
import dev.jasonpearson.automobile.protocol.PrototypeBundleLimits
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit
import okhttp3.ConnectionPool
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

internal fun interface ShareBundleResolver {
  fun resolve(host: String): List<InetAddress>
}

internal interface ShareBundleResponse : Closeable {
  val code: Int
  val location: String?
  val length: Long
  val body: InputStream
}

internal fun interface ShareBundleConnection {
  /** Connect only to this checked snapshot, retaining the URL host for TLS and HTTP. */
  fun open(url: HttpUrl, addresses: List<InetAddress>): ShareBundleResponse
}

/** One bounded GET per hop, with resolution and policy checks before each connection. */
internal class PolicyShareBundleClient(
  private val resolver: ShareBundleResolver,
  private val connection: ShareBundleConnection,
  private val policy: PrototypeDestinationPolicy = PrototypeEgressPolicy(),
  private val maxBytes: Int = PrototypeBundleLimits.MAX_COMPRESSED_BYTES,
) : ShareBundleClient {
  override fun download(url: HttpUrl): ByteArray {
    var current = url
    try {
      for (hop in 0..MAX_REDIRECTS) {
        when (val result = downloadHop(current, hop)) {
          is HopResult.Redirect -> current = result.url
          is HopResult.Completed -> return result.bytes
        }
      }
    } catch (_: PrototypeBlockedDestinationException) {
      throw ShareImportException(ShareImportError.Blocked)
    }
    throw ShareImportException(ShareImportError.Download)
  }

  private fun downloadHop(url: HttpUrl, hop: Int): HopResult {
    if (shareImportUrl(url.toString()) == null) throw ShareImportException(ShareImportError.Blocked)
    val addresses =
      PrototypePolicyDns(Dns { resolver.resolve(it) }, policy, url.port).lookup(url.host)
    return connection.open(url, addresses).use { response ->
      if (response.code in REDIRECT_CODES) {
        if (hop == MAX_REDIRECTS) throw ShareImportException(ShareImportError.Download)
        val next =
          response.location?.let(url::resolve)
            ?: throw ShareImportException(ShareImportError.Download)
        if (shareImportUrl(next.toString()) == null)
          throw ShareImportException(ShareImportError.Blocked)
        HopResult.Redirect(next)
      } else {
        if (response.code !in 200..299) throw ShareImportException(ShareImportError.Download)
        HopResult.Completed(readLimited(response))
      }
    }
  }

  private sealed interface HopResult {
    class Redirect(val url: HttpUrl) : HopResult

    class Completed(val bytes: ByteArray) : HopResult
  }

  private fun readLimited(response: ShareBundleResponse): ByteArray {
    if (response.length > maxBytes) throw ShareImportException(ShareImportError.TooLarge)
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    val stream = response.body
    while (true) {
      val count = stream.read(buffer, 0, minOf(buffer.size, maxBytes - output.size() + 1))
      if (count == -1) return output.toByteArray()
      if (output.size() + count > maxBytes) throw ShareImportException(ShareImportError.TooLarge)
      output.write(buffer, 0, count)
    }
  }

  private companion object {
    // Same bounded redirect count as the prototype HTTP transport.
    const val MAX_REDIRECTS = 5
    val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
  }
}

/** No proxies, shared pool, cookies or automatic redirects; no second DNS answer is possible. */
internal class OkHttpShareBundleConnection(
  policy: PrototypeDestinationPolicy = PrototypeEgressPolicy(),
) : ShareBundleConnection {
  private val client =
    OkHttpClient.Builder()
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .proxy(Proxy.NO_PROXY)
      .callTimeout(30, TimeUnit.SECONDS)
      .addNetworkInterceptor(PrototypeEgressInterceptor(policy))
      .build()

  override fun open(url: HttpUrl, addresses: List<InetAddress>): ShareBundleResponse {
    val snapshot = addresses.toList()
    val pool = ConnectionPool()
    val pinned =
      client
        .newBuilder()
        .connectionPool(pool)
        .dns(
          Dns { hostname ->
            if (hostname != url.host) throw IOException("Unexpected destination host")
            snapshot
          },
        )
        .build()
    // Identity encoding makes the hash and compressed cap apply to the bundle's on-host bytes.
    val request = Request.Builder().url(url).header("Accept-Encoding", "identity").build()
    val response = pinned.newCall(request).execute()
    return object : ShareBundleResponse {
      override val code = response.code
      override val location = response.header("Location")
      override val length = response.body.contentLength()
      override val body: InputStream
        get() = response.body.byteStream()

      override fun close() {
        response.close()
        pool.evictAll()
      }
    }
  }
}
