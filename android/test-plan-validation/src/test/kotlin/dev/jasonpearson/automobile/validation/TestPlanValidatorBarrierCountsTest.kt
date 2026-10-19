package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TestPlanValidatorBarrierCountsTest {
  @Test
  fun `accepts a barrier lock where every device arrives at most once per available generation`() {
    // A, A, B, B with deviceCount=2: G=2, and each device appears exactly 2
    // times (<= G) -- feasible, since generation 1 can be {A,B} and
    // generation 2 can be {A,B} using the second arrival of each.
    val yaml =
      """
      name: barrier-feasible-repeated-arrivals
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(
      result.valid,
      "Each device arriving exactly as many times as there are generations should be valid",
    )
  }

  @Test
  fun `rejects a reused barrier lock declared with more than one distinct deviceCount`() {
    // A/B at deviceCount=2, then A/B/C at deviceCount=3 for the SAME lock
    // name: the runtime coordinator keeps one shared expected count per
    // lock, so mixed-count reuse is racy and must be rejected regardless of
    // whether the distinct-device/divisibility checks would otherwise pass
    // it.
    val yaml =
      """
      name: barrier-mixed-devicecount-reuse
      devices:
        - A
        - B
        - C
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 3
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 3
        - tool: barrier
          params:
            device: C
            lock: sync-point
            deviceCount: 3
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "A lock reused with two different deviceCount values should be invalid",
    )
  }

  @Test
  fun `accepts a reused barrier lock whose deviceCount stays consistent across every use`() {
    val yaml =
      """
      name: barrier-consistent-devicecount-reuse
      devices:
        - A
        - B
        - C
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 3
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 3
        - tool: barrier
          params:
            device: C
            lock: sync-point
            deviceCount: 3
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 3
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 3
        - tool: barrier
          params:
            device: C
            lock: sync-point
            deviceCount: 3
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "A lock reused with a consistent deviceCount should be valid")
  }

  @Test
  fun `rejects a barrier deviceCount that overflows Long instead of wrapping it`() {
    // 18446744073709551618 = 2^64 + 2, a SnakeYAML BigInteger. A naive
    // Long.toLong() (or BigInteger.toLong()) narrowing wraps this to 2,
    // which would make this A/B plan pass. The value must be rejected at
    // its real magnitude, not silently wrapped into something satisfiable.
    val yaml =
      """
      name: barrier-devicecount-overflows-long
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 18446744073709551618
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 18446744073709551618
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "A deviceCount exceeding Long range must not be silently wrapped into a satisfiable value",
    )
  }

  @Test
  fun `rejects a barrier lock reachable by fewer distinct devices than its declared deviceCount`() {
    // Only device A ever arrives at this lock, so the declared
    // deviceCount=2 can never be satisfied -- mirrors the daemon's
    // PlanValidator.validateBarrierDistinctDeviceCounts.
    val yaml =
      """
      name: barrier-underpopulated-lock
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "Barrier lock reachable by only 1 distinct device but declaring deviceCount=2 should be invalid",
    )
  }

  @Test
  fun `rejects a barrier deviceCount that overflows Int instead of silently truncating it`() {
    // 4294967298 = 2^32 + 2, which truncates to 2 via a naive Int narrowing
    // -- that would make this A/B plan pass. The declared count must be
    // honored at its real magnitude (held as Long) and rejected as
    // underpopulated, not silently truncated to something satisfiable.
    val yaml =
      """
      name: barrier-devicecount-overflows-int
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 4294967298
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 4294967298
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "A deviceCount exceeding Int range must not be silently truncated into a satisfiable value",
    )
  }

  @Test
  fun `rejects a reused barrier lock whose total arrivals are not a multiple of deviceCount`() {
    // A, B, A with deviceCount=2: 2 distinct devices satisfies the
    // distinct-device check, but 3 total arrivals is not a multiple of 2 --
    // generation 1 {A,B} completes and clears, then the trailing A waits
    // alone forever. Mirrors the daemon's
    // PlanValidator.validateBarrierGenerationCompleteness.
    val yaml =
      """
      name: barrier-incomplete-trailing-generation
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "3 total arrivals is not a multiple of deviceCount=2, so this should be invalid",
    )
  }

  @Test
  fun `accepts a reused barrier lock whose total arrivals form complete generations`() {
    // A, B, A, B with deviceCount=2: 4 total arrivals is a multiple of 2,
    // so both generations complete cleanly.
    val yaml =
      """
      name: barrier-complete-generations
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "4 total arrivals is a multiple of deviceCount=2, so this is valid")
  }
}
