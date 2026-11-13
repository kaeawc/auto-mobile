package dev.jasonpearson.automobile.junit

/** Issues `issued-1`, `issued-2`, ... and records every acquisition and release, in order. */
internal class FakePlanSessionAcquirer(
  /** Answers the Nth (0-based) acquisition with this failure instead of a session. */
  private val failures: Map<Int, PlanSessionAcquisition.Failed> = emptyMap(),
) : PlanSessionAcquirer {
  val acquiredDeviceIds = mutableListOf<String?>()
  val released = mutableListOf<String>()
  /** Ordered `acquire:<deviceId>` / `issued:<uuid>` / `release:<uuid>` log. */
  val events = mutableListOf<String>()

  override fun acquire(deviceId: String?, timeoutMs: Long): PlanSessionAcquisition {
    val index = acquiredDeviceIds.size
    acquiredDeviceIds.add(deviceId)
    events.add("acquire:$deviceId")
    failures[index]?.let {
      return it
    }
    val sessionUuid = "issued-${index + 1}"
    events.add("issued:$sessionUuid")
    return PlanSessionAcquisition.Acquired(sessionUuid)
  }

  override fun release(sessionUuid: String) {
    released.add(sessionUuid)
    events.add("release:$sessionUuid")
  }
}
