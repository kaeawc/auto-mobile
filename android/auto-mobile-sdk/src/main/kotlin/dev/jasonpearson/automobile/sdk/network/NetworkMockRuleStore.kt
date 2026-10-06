package dev.jasonpearson.automobile.sdk.network

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import dev.jasonpearson.automobile.protocol.NetworkMockRuleDto
import dev.jasonpearson.automobile.protocol.NetworkMockRuleReportContract
import dev.jasonpearson.automobile.protocol.RejectedNetworkMockRule
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.ControlBroadcastReply
import dev.jasonpearson.automobile.sdk.NetworkControlReceiverRegistrar
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * Thread-safe store for network mock rules and error simulation config.
 *
 * Updated via BroadcastReceiver from control-proxy process. Queried by
 * [AutoMobileNetworkInterceptor] on every HTTP request.
 */
class NetworkMockRuleStore
@JvmOverloads
constructor(
  private val clock: () -> Long = { System.currentTimeMillis() },
  /**
   * Monotonic clock in milliseconds, immune to wall-clock steps and to the host/device skew that
   * made an absolute host expiry unusable (issue #10062). Only elapsed time is meaningful.
   */
  private val monotonicClock: () -> Long = { System.nanoTime() / 1_000_000L },
) {

  companion object {
    private const val TAG = "NetworkMockRuleStore"
    const val ACTION_NETWORK_MOCK_RULES = "dev.jasonpearson.automobile.sdk.NETWORK_MOCK_RULES"
    const val ACTION_NETWORK_ERROR_SIMULATION =
      "dev.jasonpearson.automobile.sdk.NETWORK_ERROR_SIMULATION"
    const val EXTRA_RULES_JSON = "rules_json"
    const val EXTRA_ERROR_SIM_ENABLED = "enabled"
    const val EXTRA_ERROR_SIM_TYPE = "error_type"
    const val EXTRA_ERROR_SIM_LIMIT = "limit"
    const val EXTRA_ERROR_SIM_EXPIRES_AT = "expires_at"
    const val EXTRA_ERROR_SIM_REMAINING_MS = "remaining_ms"
    @Volatile private var instance: NetworkMockRuleStore? = null

    fun getInstance(): NetworkMockRuleStore {
      return instance
        ?: synchronized(this) { instance ?: NetworkMockRuleStore().also { instance = it } }
    }

    fun initialize(context: Context) {
      getInstance().registerReceiver(context)
    }

    fun shutdown(context: Context) {
      getInstance().apply {
        unregisterReceiver(context)
        clear()
      }
    }
  }

  /** Interface for the interceptor to query rules without depending on the full store. */
  interface RuleMatcher {
    fun findMatchingRule(host: String, path: String, method: String): MatchedMockRule?

    fun getErrorSimulation(): ErrorSimulationConfig?
  }

  data class CompiledMockRule(
    val mockId: String,
    val hostRegex: Regex,
    val pathRegex: Regex,
    val method: String,
    val limit: Int?,
    val remaining: AtomicInteger?,
    val statusCode: Int,
    val responseHeaders: Map<String, String>,
    val responseBody: String,
    val contentType: String,
  )

  data class MatchedMockRule(
    val mockId: String,
    val statusCode: Int,
    val responseHeaders: Map<String, String>,
    val responseBody: String,
    val contentType: String,
  )

  data class ErrorSimulationConfig(
    val errorType: String,
    val limit: Int?,
    val remaining: AtomicInteger?,
    val expiresAtEpochMs: Long,
    /**
     * Deadline on the store's monotonic clock when the host sent a remaining duration. When
     * non-null it decides expiry and [expiresAtEpochMs] is informational only.
     */
    val deadlineMonotonicMs: Long? = null,
  )

  @Volatile private var rules: List<CompiledMockRule> = emptyList()
  @Volatile private var errorSimulation: ErrorSimulationConfig? = null

  private val json = Json { ignoreUnknownKeys = true }
  private val controlReceiverRegistrar = NetworkControlReceiverRegistrar { _, intent, reply ->
    handleControlBroadcast(intent, reply)
  }

  val ruleMatcher: RuleMatcher =
    object : RuleMatcher {
      override fun findMatchingRule(
        host: String,
        path: String,
        method: String,
      ): MatchedMockRule? {
        return this@NetworkMockRuleStore.findMatchingRule(host, path, method)
      }

      override fun getErrorSimulation(): ErrorSimulationConfig? {
        return this@NetworkMockRuleStore.getActiveErrorSimulation()
      }
    }

  /**
   * Replace the rule list. The host re-sends its whole list on every change and on every reconnect,
   * so a rule the store already holds keeps its use counter instead of being re-armed from the
   * incoming `remaining` (issue #10060). Identity is the host-assigned `mockId` (never reused
   * within a daemon run) plus an unchanged definition; a changed rule, or a new app process, starts
   * with a fresh counter.
   */
  fun setRules(dtos: List<NetworkMockRuleDto>) {
    applyRules(dtos)
  }

  /**
   * [setRules] that also returns the rules this device's regex engine refused (ICU on Android
   * differs from the host's JavaScript engine), each with the compiler's message, so the host can
   * report them as not installed instead of assuming every pushed rule took (issue #10101).
   */
  fun applyRules(dtos: List<NetworkMockRuleDto>): List<RejectedNetworkMockRule> {
    val previousById = rules.associateBy { it.mockId }
    val rejected = mutableListOf<RejectedNetworkMockRule>()
    val compiledRules = buildList {
      for (dto in dtos) {
        try {
          val previous = previousById[dto.mockId]?.takeIf { it.isSameDefinitionAs(dto) }
          add(
            CompiledMockRule(
              mockId = dto.mockId,
              hostRegex = Regex(dto.host),
              pathRegex = Regex(dto.path),
              method = dto.method,
              limit = dto.limit,
              remaining =
                if (previous != null) previous.remaining
                else dto.remaining?.let { AtomicInteger(it) },
              statusCode = dto.statusCode,
              responseHeaders = dto.responseHeaders,
              responseBody = dto.responseBody,
              contentType = dto.contentType,
            )
          )
        } catch (e: Exception) {
          val reason = "invalid regex: ${e.message}"
          AutoMobileSDK.logger.w(TAG) { "Skipping mock rule ${dto.mockId}: $reason" }
          rejected += RejectedNetworkMockRule(dto.mockId, reason)
        }
      }
    }
    rules = compiledRules
    AutoMobileSDK.logger.d(TAG) { "Updated mock rules: ${compiledRules.size} active" }
    return rejected
  }

  private fun CompiledMockRule.isSameDefinitionAs(dto: NetworkMockRuleDto): Boolean =
    limit == dto.limit &&
      method == dto.method &&
      hostRegex.pattern == dto.host &&
      pathRegex.pattern == dto.path

  @JvmOverloads
  fun setErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
    remainingMs: Long? = null,
  ) {
    // A remaining duration is measured on this device's monotonic clock; the absolute host epoch
    // is only the fallback for older hosts that send nothing else.
    val boundedRemainingMs = remainingMs?.coerceAtLeast(0L)
    val epochMs = expiresAtEpochMs ?: boundedRemainingMs?.let { clock() + it }
    errorSimulation =
      if (enabled && errorType != null && epochMs != null) {
        ErrorSimulationConfig(
          errorType = errorType,
          limit = limit,
          remaining = limit?.let { AtomicInteger(it) },
          expiresAtEpochMs = epochMs,
          deadlineMonotonicMs = boundedRemainingMs?.let { monotonicClock() + it },
        )
      } else {
        null
      }
    AutoMobileSDK.logger.d(TAG) { "Error simulation: ${if (enabled) errorType else "disabled"}" }
  }

  fun findMatchingRule(host: String, path: String, method: String): MatchedMockRule? {
    val snapshot = rules
    for (rule in snapshot) {
      if (rule.method != "*" && !rule.method.equals(method, ignoreCase = true)) continue
      if (!rule.hostRegex.containsMatchIn(host)) continue
      if (!rule.pathRegex.containsMatchIn(path)) continue

      // Check remaining limit
      val remaining = rule.remaining
      if (remaining != null) {
        val left = remaining.decrementAndGet()
        if (left < 0) continue
      }

      return MatchedMockRule(
        mockId = rule.mockId,
        statusCode = rule.statusCode,
        responseHeaders = rule.responseHeaders,
        responseBody = rule.responseBody,
        contentType = rule.contentType,
      )
    }
    return null
  }

  fun getActiveErrorSimulation(): ErrorSimulationConfig? {
    val sim = errorSimulation ?: return null
    if (isExpired(sim)) {
      errorSimulation = null
      return null
    }
    val remaining = sim.remaining
    if (remaining != null) {
      val left = remaining.decrementAndGet()
      if (left < 0) {
        errorSimulation = null
        return null
      }
    }
    return sim
  }

  private fun isExpired(sim: ErrorSimulationConfig): Boolean {
    val deadline = sim.deadlineMonotonicMs
    return if (deadline != null) monotonicClock() >= deadline else clock() >= sim.expiresAtEpochMs
  }

  fun clear() {
    rules = emptyList()
    errorSimulation = null
  }

  fun getRuleCount(): Int = rules.size

  @Synchronized
  fun registerReceiver(context: Context) {
    controlReceiverRegistrar.register(context) {
      IntentFilter().apply {
        addAction(ACTION_NETWORK_MOCK_RULES)
        addAction(ACTION_NETWORK_ERROR_SIMULATION)
      }
    }
    AutoMobileSDK.logger.d(TAG) {
      "Registered broadcast receivers for network mock rules (permission-gated)"
    }
  }

  @Synchronized
  fun unregisterReceiver(context: Context) {
    controlReceiverRegistrar.unregister(context)
  }

  /** Visible to tests: applies one control broadcast and answers it when it is ordered. */
  internal fun handleControlBroadcast(intent: Intent?, reply: ControlBroadcastReply? = null) {
    if (intent == null) return
    when (intent.action) {
      ACTION_NETWORK_MOCK_RULES -> {
        val rulesJson = intent.getStringExtra(EXTRA_RULES_JSON) ?: return
        try {
          val dtos =
            json.decodeFromString(
              ListSerializer(NetworkMockRuleDto.serializer()),
              rulesJson,
            )
          val rejected = applyRules(dtos)
          // Only an ordered broadcast has a reply channel; a plain one (an older CtrlProxy, or a
          // reconnect resync) cannot be answered and nothing waits for it.
          if (reply != null && reply.isOrdered) {
            reply.resultData = NetworkMockRuleReportContract.append(reply.resultData, rejected)
          }
        } catch (e: Exception) {
          AutoMobileSDK.logger.e(TAG) { "Failed to parse mock rules: ${e.message}" }
        }
      }
      ACTION_NETWORK_ERROR_SIMULATION -> {
        val enabled = intent.getBooleanExtra(EXTRA_ERROR_SIM_ENABLED, false)
        val errorType = intent.getStringExtra(EXTRA_ERROR_SIM_TYPE)
        val limit = intent.getIntExtra(EXTRA_ERROR_SIM_LIMIT, -1).let { if (it == -1) null else it }
        val expiresAt =
          intent.getLongExtra(EXTRA_ERROR_SIM_EXPIRES_AT, -1).let {
            if (it == -1L) null else it
          }
        val remainingMs =
          intent.getLongExtra(EXTRA_ERROR_SIM_REMAINING_MS, -1L).let { if (it < 0L) null else it }
        setErrorSimulation(enabled, errorType, limit, expiresAt, remainingMs)
      }
    }
  }
}
