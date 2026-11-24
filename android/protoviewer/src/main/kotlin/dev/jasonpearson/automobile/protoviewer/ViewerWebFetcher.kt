package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeBlockedDestinationException
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeEgressInterceptor
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeEgressPolicy
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypePolicyDns
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeWebFetchResult
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeWebFetcher
import java.io.IOException
import java.net.Proxy
import java.util.concurrent.TimeUnit
import okhttp3.CookieJar
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/** Transport for intercepted requests. Only the renderer follows redirects. */
internal class ViewerWebFetcher(private val dns: Dns = Dns.SYSTEM) : PrototypeWebFetcher {
  private val policy = PrototypeEgressPolicy(blockPrivateAddresses = true)
  private val client =
    OkHttpClient.Builder()
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .proxy(Proxy.NO_PROXY)
      .cookieJar(CookieJar.NO_COOKIES)
      .callTimeout(15, TimeUnit.SECONDS)
      .addNetworkInterceptor(PrototypeEgressInterceptor(policy))
      .build()

  override fun fetch(
    url: String,
    method: String,
    headers: Map<String, String>,
  ): PrototypeWebFetchResult {
    val destination =
      url.toHttpUrlOrNull() ?: return PrototypeWebFetchResult(502, "Invalid Upstream URL")
    return try {
      val request =
        Request.Builder()
          .url(destination)
          .method(method, null)
          .apply {
            headers.forEach { (name, value) -> header(name, value) }
          }
          .build()
      client
        .newBuilder()
        .dns(PrototypePolicyDns(dns, policy, destination.port))
        .build()
        .newCall(request)
        .execute()
        .toWebFetchResult()
    } catch (_: PrototypeBlockedDestinationException) {
      PrototypeWebFetchResult(403, "Forbidden", destinationBlocked = true)
    } catch (_: IOException) {
      PrototypeWebFetchResult(502, "Upstream Request Failed")
    } catch (_: IllegalArgumentException) {
      PrototypeWebFetchResult(502, "Invalid Upstream Request")
    }
  }

  private fun Response.toWebFetchResult(): PrototypeWebFetchResult {
    val stream = body.byteStream()
    if (code !in 200..599) {
      close()
      return PrototypeWebFetchResult(502, "Invalid Upstream Response")
    }
    return PrototypeWebFetchResult(
      code,
      message.takeIf { text -> text.isNotBlank() && text.all { it in ' '..'~' } } ?: "HTTP $code",
      headers
        .names()
        .filterNot { it.lowercase() in suppressedResponseHeaders }
        .associateWith { headers.values(it).joinToString(", ") } +
        ("X-DNS-Prefetch-Control" to "off"),
      stream,
      redirectLocation = header("Location"),
    )
  }

  private companion object {
    val suppressedResponseHeaders =
      setOf("set-cookie", "set-cookie2", "alt-svc", "link", "x-dns-prefetch-control")
  }
}
