package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapturePolicy
import java.io.IOException
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertSame
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.buffer
import org.junit.Test

internal class AutoMobileNetworkInterceptorPolicyTest : AutoMobileNetworkInterceptorFixture() {
  @Test
  fun `observation failures leave a successful host request unchanged`() {
    val buffer = throwingBuffer()
    var proceedCalls = 0
    val interceptor =
      AutoMobileNetworkInterceptor(
        buffer,
        ruleStore =
          object : NetworkMockRuleStore.RuleMatcher {
            override fun findMatchingRule(host: String, path: String, method: String): Nothing =
              throw IllegalStateException("rule matching failed")

            override fun getErrorSimulation(): NetworkMockRuleStore.ErrorSimulationConfig? = null
          },
        policyProvider = { SdkCapturePolicy(allowMutations = true) },
        networkControlProvider = { true },
      )

    val response =
      interceptor.intercept(
        FakeInterceptorChain(
          ChainOptions().apply {
            this.responseCode = 202
            this.onProceed = { proceedCalls++ }
          },
        ),
      )

    assertEquals(1, proceedCalls)
    assertEquals(202, response.code)
  }

  @Test
  fun `observation failures leave a failed host request unchanged`() {
    val buffer = throwingBuffer()
    val hostFailure = IOException("host failure")
    var proceedCalls = 0
    val interceptor =
      AutoMobileNetworkInterceptor(
        buffer,
        policyProvider = { throw IllegalStateException("policy failed") },
      )

    val thrown =
      assertFailsWith<IOException> {
        interceptor.intercept(
          FakeInterceptorChain(
            ChainOptions().apply {
              this.throwOnProceed = hostFailure
              this.onProceed = { proceedCalls++ }
            },
          ),
        )
      }

    assertEquals(1, proceedCalls)
    assertSame(hostFailure, thrown)
  }

  @Test
  fun `mock rules require an explicitly enabled network control policy`() {
    val (buffer, _) = collectingBuffer()
    val mockRule =
      NetworkMockRuleStore.MatchedMockRule(
        mockId = "mock-1",
        statusCode = 503,
        responseHeaders = emptyMap(),
        responseBody = "mocked",
        contentType = "text/plain",
      )
    var proceedCalls = 0
    val interceptor =
      AutoMobileNetworkInterceptor(
        buffer,
        ruleStore = fakeRuleMatcher(matchResult = mockRule),
      )

    val response =
      interceptor.intercept(
        FakeInterceptorChain(
          ChainOptions().apply {
            this.responseCode = 204
            this.onProceed = { proceedCalls++ }
          },
        ),
      )

    assertEquals(1, proceedCalls)
    assertEquals(204, response.code)
  }

  @Test
  fun `policy lookup failure disables sensitive capture`() {
    val (buffer, flushed) = collectingBuffer()
    val request =
      Request.Builder()
        .url("https://api.example.com/users")
        .header("Authorization", "Bearer token")
        .post("secret".toRequestBody("text/plain".toMediaType()))
        .build()
    val interceptor =
      AutoMobileNetworkInterceptor(
        buffer,
        captureHeaders = true,
        captureBodies = true,
        policyProvider = { throw IllegalStateException("policy failed") },
      )

    interceptor.intercept(
      fakeChain {
        this.request = request
      },
    )
    drainDelivery()

    val event = flushed.single().single() as SdkNetworkRequestEvent
    assertNull(event.requestHeaders)
    assertNull(event.responseHeaders)
    assertNull(event.requestBody)
    assertNull(event.responseBody)
  }

  @Test
  fun `invalid mock response falls through without recording a mock event`() {
    val (buffer, flushed) = collectingBuffer()
    var proceedCalls = 0
    val mockRule =
      NetworkMockRuleStore.MatchedMockRule(
        mockId = "mock-1",
        statusCode = 503,
        responseHeaders = mapOf("X-Invalid" to "line\nbreak"),
        responseBody = "mocked",
        contentType = "text/plain",
      )
    val interceptor = mutationEnabledInterceptor(buffer, fakeRuleMatcher(matchResult = mockRule))

    val response =
      interceptor.intercept(
        FakeInterceptorChain(
          ChainOptions().apply {
            this.responseCode = 204
            this.onProceed = { proceedCalls++ }
          },
        ),
      )
    drainDelivery()

    assertEquals(1, proceedCalls)
    assertEquals(204, response.code)
    assertEquals(1, flushed.flatten().size)
    assertNull((flushed.single().single() as SdkNetworkRequestEvent).error)
  }
}
