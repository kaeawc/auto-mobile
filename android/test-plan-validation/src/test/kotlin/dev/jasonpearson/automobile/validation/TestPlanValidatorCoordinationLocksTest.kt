package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TestPlanValidatorCoordinationLocksTest {
  @Test
  fun `rejects an authored inline __lockNamespace on a barrier step`() {
    val yaml =
      """
      name: barrier-authored-lock-namespace-inline
      devices:
        - A
        - B
      steps:
        - tool: barrier
          device: A
          lock: sync1
          deviceCount: 2
          __lockNamespace: one
        - tool: barrier
          device: B
          lock: sync1
          deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "An authored inline __lockNamespace on a barrier step should be invalid",
    )
  }

  @Test
  fun `rejects an authored __lockNamespace on a criticalSection step's params`() {
    val yaml =
      """
      name: critical-section-authored-lock-namespace
      devices:
        - A
      steps:
        - tool: criticalSection
          params:
            device: A
            lock: sync1
            deviceCount: 1
            __lockNamespace: one
            steps:
              - tool: observe
                params:
                  device: A
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "An authored __lockNamespace on a criticalSection step should be invalid",
    )
  }

  @Test
  fun `accepts a normal barrier plan that does not author __lockNamespace`() {
    val yaml =
      """
      name: barrier-normal-no-lock-namespace
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync1
            deviceCount: 2
        - tool: barrier
          params:
            device: B
            lock: sync1
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "A normal barrier plan without __lockNamespace should be valid")
  }

  @Test
  fun `rejects the same lock name used by both a criticalSection and a barrier step`() {
    // Both tools share the runtime coordinator's lock namespace and
    // expected-count state, so a criticalSection A/B pair and a barrier
    // C/D pair both using lock "shared" with deviceCount=2 can pair
    // mismatched participants and overwrite each other's expected count.
    val yaml =
      """
      name: lock-shared-across-tool-types
      devices:
        - A
        - B
        - C
        - D
      steps:
        - tool: criticalSection
          params:
            device: A
            lock: shared
            deviceCount: 2
            steps:
              - tool: observe
                params:
                  device: A
        - tool: criticalSection
          params:
            device: B
            lock: shared
            deviceCount: 2
            steps:
              - tool: observe
                params:
                  device: B
        - tool: barrier
          params:
            device: C
            lock: shared
            deviceCount: 2
        - tool: barrier
          params:
            device: D
            lock: shared
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "A lock shared between criticalSection and barrier should be invalid")
  }

  @Test
  fun `accepts criticalSection and barrier using distinct lock names`() {
    val yaml =
      """
      name: distinct-locks-per-tool-type
      devices:
        - A
        - B
        - C
        - D
      steps:
        - tool: criticalSection
          params:
            device: A
            lock: cs-lock
            deviceCount: 2
            steps:
              - tool: observe
                params:
                  device: A
        - tool: criticalSection
          params:
            device: B
            lock: cs-lock
            deviceCount: 2
            steps:
              - tool: observe
                params:
                  device: B
        - tool: barrier
          params:
            device: C
            lock: barrier-lock
            deviceCount: 2
        - tool: barrier
          params:
            device: D
            lock: barrier-lock
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Distinct lock names per tool type should be valid")
  }

  @Test
  fun `rejects an authored __lockNamespace on a barrier step's params`() {
    // __lockNamespace is a reserved field injected internally by
    // PlanExecutor at runtime to scope a plan's lock state. If two
    // participants authored different truthy values for the same lock,
    // every per-lock feasibility check would pass yet they'd wait in
    // separate namespaced barriers at runtime until timeout (#6215 review).
    val yaml =
      """
      name: barrier-authored-lock-namespace
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync1
            deviceCount: 2
            __lockNamespace: one
        - tool: barrier
          params:
            device: B
            lock: sync1
            deviceCount: 2
            __lockNamespace: two
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "An authored __lockNamespace on a barrier step should be invalid")
  }
}
