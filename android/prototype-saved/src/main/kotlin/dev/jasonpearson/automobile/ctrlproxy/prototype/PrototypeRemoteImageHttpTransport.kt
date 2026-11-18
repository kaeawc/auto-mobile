package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeRemoteImages
import dev.jasonpearson.automobile.prototype.saved.BuildConfig
import java.io.IOException
import java.net.URI
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import retrofit2.Response

/** Uses the request service and its DNS/socket enforcement, with the stricter image policy. */
internal class PrototypeRemoteImageHttpTransport(
  policy: PrototypeDestinationPolicy,
  service: (PrototypeDestinationPolicy) -> PrototypeHttpService,
) : PrototypeRemoteImageTransport {
  private val allowLoopback = BuildConfig.DEBUG
  private val publicPolicy = imagePolicy(policy, false)
  private val localPolicy = imagePolicy(policy, allowLoopback)
  private val publicService = service(publicPolicy)
  private val localService = service(localPolicy)

  override suspend fun download(url: String): ByteArray {
    var destination = checkedUrl(url, allowLoopback)
    val requestAllowsLoopback = allowLoopback && !destination.isHttps
    for (hop in 0..MAX_REDIRECTS) {
      val policy = if (destination.isHttps) publicPolicy else localPolicy
      policy.check(destination.host, destination.port, emptyList()).requireAllowed()
      val transport = if (destination.isHttps) publicService else localService
      val response =
        transport.get(
          PrototypeEgressPolicy.normalize(destination).toString(),
          emptyMap(),
          PrototypeCallTimeout(30_000),
        )
      if (response.code() !in REDIRECT_CODES) return read(response)
      val location = response.headers()["Location"]
      response.body()?.close()
      response.errorBody()?.close()
      if (location == null || hop == MAX_REDIRECTS) throw IOException("Remote image unavailable")
      destination = redirect(destination, location, requestAllowsLoopback)
    }
    throw IOException("Remote image unavailable")
  }

  private fun redirect(
    destination: HttpUrl,
    location: String,
    requestAllowsLoopback: Boolean,
  ): HttpUrl =
    try {
      // Validate the spelling before OkHttp canonicalizes numeric hosts into loopback literals.
      when {
        URI.create(location).isAbsolute -> checkedUrl(location, requestAllowsLoopback)
        location.startsWith("//") ->
          checkedUrl("${destination.scheme}:$location", requestAllowsLoopback)
      }
      val resolved = destination.resolve(location) ?: throw IOException("Remote image unavailable")
      checkedUrl(resolved.toString(), requestAllowsLoopback)
    } catch (error: IllegalArgumentException) {
      throw IOException("Remote image unavailable", error)
    }

  private fun checkedUrl(url: String, allowLoopback: Boolean): HttpUrl {
    if (!prototypeRemoteImageUrlAllowed(url, allowLoopback))
      throw IOException("Remote image unavailable")
    return url.toHttpUrlOrNull() ?: throw IOException("Remote image unavailable")
  }

  private suspend fun read(response: Response<ResponseBody>): ByteArray {
    response.errorBody()?.close()
    val body = response.body()
    if (!response.isSuccessful || body == null) {
      body?.close()
      throw IOException("Remote image unavailable")
    }
    return coroutineScope {
      // The loader calls on IO. Await separately so cancellation closes the streaming body
      // immediately, unblocking a socket read when ProtoViewer revokes network consent.
      val reader = async { readLimited(body) }
      try {
        reader.await()
      } finally {
        body.close()
      }
    }
  }

  private fun readLimited(body: ResponseBody): ByteArray {
    val limit = PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES.toLong()
    if (body.contentLength() > limit) throw IOException("Remote image unavailable")
    val source = body.source()
    source.request(limit + 1)
    if (source.buffer.size > limit) throw IOException("Remote image unavailable")
    return source.readByteArray()
  }

  private companion object {
    fun imagePolicy(
      base: PrototypeDestinationPolicy,
      allowLoopback: Boolean,
    ): PrototypeDestinationPolicy {
      if (base is PrototypeEgressPolicy) return base.forRemoteImages(allowLoopback)
      val strict = PrototypeEgressPolicy(allowLoopback = allowLoopback, blockPrivateNetworks = true)
      return PrototypeDestinationPolicy { host, port, addresses ->
        val decision = strict.check(host, port, addresses)
        if (decision == PrototypeEgressDecision.Allow) base.check(host, port, addresses)
        else decision
      }
    }

    const val MAX_REDIRECTS = 5
    val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
  }
}

/** Retrofit buffers non-2xx bodies even with @Streaming. Close errors/redirects before that. */
internal object PrototypeRemoteImageResponseInterceptor : Interceptor {
  override fun intercept(chain: Interceptor.Chain): okhttp3.Response {
    val response = chain.proceed(chain.request())
    return if (response.isSuccessful) response
    else {
      response.body.close()
      response.newBuilder().body(ByteArray(0).toResponseBody()).build()
    }
  }
}
