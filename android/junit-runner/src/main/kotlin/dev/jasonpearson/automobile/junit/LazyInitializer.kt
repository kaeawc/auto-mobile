package dev.jasonpearson.automobile.junit

/**
 * Phase 4 optimization: Lazy initialization of heavy components. Delays expensive initialization
 * until actually needed.
 */
object LazyInitializer {
  private var _agent: AutoMobileAgent? = null

  fun getAgent(): AutoMobileAgent = getAgent(DaemonSocketClientManager)

  internal fun getAgent(daemon: DaemonToolClient = DaemonSocketClientManager): AutoMobileAgent {
    // Only the production daemon shares an agent and its recovery-config cache across executions.
    if (daemon !== DaemonSocketClientManager) return AutoMobileAgent.forDaemon(daemon)
    return _agent ?: AutoMobileAgent.forDaemon(daemon).also { _agent = it }
  }

  fun clear() {
    _agent = null
  }
}
