package dev.jasonpearson.automobile.validation

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class TestPlanValidatorTest {

  // ========== Valid Plan Tests ==========

  @Test
  fun `validates minimal valid plan`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Plan should be valid")
    assertTrue(result.errors.isEmpty(), "Should have no errors")
  }

  @Test
  fun `validates complete plan with all fields`() {
    val yaml =
      """
      name: complete-plan
      description: A complete test plan
      devices:
        - A
        - B
      steps:
        - tool: launchApp
          params:
            appId: com.example.app
          device: A
          label: Launch app on device A
        - tool: observe
          params:
            device: A
      metadata:
        createdAt: "2026-01-08T00:00:00Z"
        version: "1.0.0"
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Complete plan should be valid")
  }

  @Test
  fun `validates plan with YAML anchors`() {
    val yaml =
      """
      name: anchors-test
      description: Test with YAML anchors
      steps:
        - tool: launchApp
          params: &launch-params
            appId: com.example.app
            coldBoot: false
          label: First launch
        - tool: launchApp
          params:
            <<: *launch-params
            coldBoot: true
          label: Second launch with cold boot
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Plan with YAML anchors should be valid")
  }

  @Test
  fun `validates plan with merge keys`() {
    val yaml =
      """
      name: merge-keys-test
      devices:
        - A
        - B
      steps:
        - tool: observe
          params: &observe-base
            includeScreenshot: true
            includeHierarchy: true
            device: A
        - tool: observe
          params:
            <<: *observe-base
            device: B
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Plan with merge keys should be valid")
  }

  @Test
  fun `validates critical section parameters`() {
    val yaml =
      """
      name: critical-section-test
      devices:
        - A
        - B
      steps:
        - tool: criticalSection
          params:
            device: A
            lock: sync-point
            deviceCount: 2
            steps:
              - tool: tapOn
                params:
                  device: A
                  text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Critical section plan should be valid")
  }

  @Test
  fun `validates barrier parameters`() {
    val yaml =
      """
      name: barrier-test
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
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Barrier plan should be valid")
  }

  @Test
  fun `rejects a plan with valid barriers plus a device-less non-coordination step`() {
    // devices=[A,B] and both barrier steps are individually valid, but the
    // trailing tapOn step declares no device at all. The daemon's
    // PlanValidator.validateDeviceLabelsPresent checks every step
    // generically, not just barrier/criticalSection -- this must be
    // rejected here too (#6215 review).
    val yaml =
      """
      name: barrier-plan-with-device-less-tapon
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
        - tool: tapOn
          params:
            text: Continue
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "A device-less tapOn step under a plan that declares devices should be invalid",
    )
  }

  @Test
  fun `rejects a plan with valid barriers plus a non-coordination step targeting an undeclared device`() {
    val yaml =
      """
      name: barrier-plan-with-undeclared-device-tapon
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
        - tool: tapOn
          params:
            device: C
            text: Continue
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "A tapOn step targeting an undeclared device should be invalid",
    )
  }

  @Test
  fun `rejects barrier missing lock`() {
    val yaml =
      """
      name: barrier-missing-lock
      devices:
        - A
      steps:
        - tool: barrier
          params:
            device: A
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Barrier missing 'lock' should be invalid")
  }

  @Test
  fun `rejects barrier missing deviceCount`() {
    val yaml =
      """
      name: barrier-missing-devicecount
      devices:
        - A
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Barrier missing 'deviceCount' should be invalid")
  }

  @Test
  fun `rejects barrier with wrong-typed deviceCount`() {
    val yaml =
      """
      name: barrier-bad-devicecount-type
      devices:
        - A
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: "two"
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Barrier with a non-numeric deviceCount should be invalid")
  }

  @Test
  fun `rejects criticalSection missing lock`() {
    val yaml =
      """
      name: critical-section-missing-lock
      devices:
        - A
      steps:
        - tool: criticalSection
          params:
            deviceCount: 2
            steps:
              - tool: tapOn
                params:
                  device: A
                  text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "criticalSection missing 'lock' should be invalid")
  }

  @Test
  fun `rejects criticalSection missing deviceCount`() {
    val yaml =
      """
      name: critical-section-missing-devicecount
      devices:
        - A
      steps:
        - tool: criticalSection
          params:
            lock: sync-point
            steps:
              - tool: tapOn
                params:
                  device: A
                  text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "criticalSection missing 'deviceCount' should be invalid")
  }

  @Test
  fun `accepts barrier with inline coordination params (no nested params object)`() {
    // Plans may place lock/deviceCount/device directly on the step, the same
    // inline-vs-params shape criticalSection (and most other tools) accept.
    val yaml =
      """
      name: barrier-inline-test
      devices:
        - A
        - B
      steps:
        - tool: barrier
          device: A
          lock: sync-point
          deviceCount: 2
        - tool: barrier
          device: B
          lock: sync-point
          deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Inline-form barrier plan should be valid")
  }

  @Test
  fun `accepts barrier with coordination fields split across inline and params`() {
    // PlanNormalizer merges inline fields and params together before
    // execution, so a field counts as present wherever it appears -- lock
    // inline + deviceCount in params must validate. A second device's
    // arrival is included so the lock's declared deviceCount=2 is
    // satisfiable by 2 distinct devices.
    val yaml =
      """
      name: barrier-split-fields-test
      devices:
        - A
        - B
      steps:
        - tool: barrier
          lock: sync-point
          params:
            device: A
            deviceCount: 2
        - tool: barrier
          lock: sync-point
          params:
            device: B
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Split-field barrier plan should be valid")
  }

  @Test
  fun `rejects barrier missing deviceCount from both inline and params`() {
    val yaml =
      """
      name: barrier-split-fields-missing-devicecount
      devices:
        - A
      steps:
        - tool: barrier
          lock: sync-point
          params:
            device: A
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Barrier missing deviceCount from both locations should be invalid")
  }

  @Test
  fun `accepts criticalSection with inline coordination params`() {
    val yaml =
      """
      name: critical-section-inline-test
      devices:
        - A
      steps:
        - tool: criticalSection
          device: A
          lock: sync-point
          deviceCount: 1
          steps:
            - tool: tapOn
              params:
                device: A
                text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Inline-form criticalSection plan should be valid")
  }

  @Test
  fun `rejects barrier with a zero timeout`() {
    val yaml =
      """
      name: barrier-zero-timeout
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
            timeout: 0
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "barrier with timeout=0 should be invalid")
  }

  @Test
  fun `rejects barrier with a malformed platform value`() {
    // addDeviceTargetingToSchema restricts platform to android/ios at
    // execution; the authoring schema must reject an invalid value too,
    // instead of only failing at execution (#6215 review).
    val yaml =
      """
      name: barrier-malformed-platform
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
            platform: windows
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "barrier with platform=windows should be invalid")
  }

  @Test
  fun `accepts barrier with a valid platform value`() {
    val yaml =
      """
      name: barrier-valid-platform
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
            platform: android
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 2
            platform: android
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "barrier with platform=android should be valid")
  }

  @Test
  fun `accepts a criticalSection sub-step with a discarded invalid inline device overridden by a valid params device`() {
    // PlanNormalizer.normalizeSteps merges params over inline fields for
    // EVERY step, not just the outer criticalSection/barrier step -- a
    // nested sub-step is itself validated as a planStep (via the
    // criticalSectionParams.steps $ref), so this precedence must be
    // honored there too (#6215 review).
    val yaml =
      """
      name: critical-section-substep-device-override
      devices:
        - A
      steps:
        - tool: criticalSection
          params:
            device: A
            lock: sync-point
            deviceCount: 1
            steps:
              - tool: tapOn
                device: 123
                params:
                  device: A
                  text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(
      result.valid,
      "A discarded invalid inline device overridden by a valid params.device should be valid",
    )
  }

  @Test
  fun `rejects a criticalSection sub-step with an invalid inline device when params does not override it`() {
    val yaml =
      """
      name: critical-section-substep-invalid-device
      devices:
        - A
      steps:
        - tool: criticalSection
          params:
            device: A
            lock: sync-point
            deviceCount: 1
            steps:
              - tool: tapOn
                device: 123
                params:
                  text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "An un-overridden invalid inline device should be invalid")
  }

  @Test
  fun `rejects an invalid inline device when params is null`() {
    // JSON Schema's "required" keyword vacuously passes against a
    // non-object value, so a naive "params has device" guard would treat
    // params: null as if it declared 'device', wrongly skipping the inline
    // check. The guard must require params to be an object before
    // trusting its presence (#6215 review).
    val yaml =
      """
      name: tapon-null-params-invalid-device
      devices:
        - A
      steps:
        - tool: tapOn
          device: 123
          params: null
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "An invalid inline device with params: null should be invalid")
  }

  @Test
  fun `accepts a valid inline device when params is null`() {
    val yaml =
      """
      name: tapon-null-params-valid-device
      devices:
        - A
      steps:
        - tool: tapOn
          device: A
          params: null
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "A valid inline device with params: null should be valid")
  }

  @Test
  fun `rejects a whitespace-only declared device label`() {
    // A whitespace-only label like " " satisfies the schema's minLength:1
    // (and now the non-whitespace pattern too), but the daemon trims
    // labels before checking emptiness -- mirrors
    // PlanValidator.validateDevicesField (#6215 review).
    val yaml =
      """
      name: whitespace-only-device-label
      devices:
        - " "
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "A whitespace-only device label should be invalid")
  }

  @Test
  fun `rejects a barrier with an inline malformed platform value`() {
    // The inline form must be constrained the same as the nested-params
    // form, or PlanNormalizer moving it into params later would make the
    // runtime addDeviceTargetingToSchema reject a plan this authoring
    // schema accepted (#6215 review).
    val yaml =
      """
      name: barrier-inline-malformed-platform
      devices:
        - A
        - B
      steps:
        - tool: barrier
          device: A
          lock: sync-point
          deviceCount: 2
          platform: windows
        - tool: barrier
          device: B
          lock: sync-point
          deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "An inline platform=windows should be invalid")
  }

  @Test
  fun `accepts a barrier with an inline valid platform value`() {
    val yaml =
      """
      name: barrier-inline-valid-platform
      devices:
        - A
        - B
      steps:
        - tool: barrier
          device: A
          lock: sync-point
          deviceCount: 2
          platform: android
        - tool: barrier
          device: B
          lock: sync-point
          deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "An inline platform=android should be valid")
  }

  @Test
  fun `accepts barrier with a positive timeout`() {
    // Both A and B arrive so the declared deviceCount=2 is satisfiable by 2
    // distinct devices.
    val yaml =
      """
      name: barrier-positive-timeout
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 2
            timeout: 5000
        - tool: barrier
          params:
            device: B
            lock: sync-point
            deviceCount: 2
            timeout: 5000
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "barrier with a positive timeout should be valid")
  }

  @Test
  fun `rejects criticalSection with a zero timeout`() {
    val yaml =
      """
      name: critical-section-zero-timeout
      devices:
        - A
      steps:
        - tool: criticalSection
          params:
            lock: sync-point
            deviceCount: 1
            timeout: 0
            steps:
              - tool: tapOn
                params:
                  device: A
                  text: Button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "criticalSection with timeout=0 should be invalid")
  }

  @Test
  fun `accepts barrier with invalid inline deviceCount overridden by a valid params deviceCount`() {
    // PlanNormalizer's params-wins merge discards the inline sibling, so the
    // effective (params) value is what must be validated.
    val yaml =
      """
      name: barrier-inline-invalid-params-valid
      devices:
        - A
        - B
      steps:
        - tool: barrier
          device: A
          lock: sync-point
          deviceCount: not-a-number
          params:
            deviceCount: 2
        - tool: barrier
          device: B
          lock: sync-point
          params:
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(
      result.valid,
      "Effective (params) deviceCount should be validated, not the discarded inline value",
    )
  }

  @Test
  fun `rejects barrier with a valid inline deviceCount overridden by an invalid params deviceCount`() {
    val yaml =
      """
      name: barrier-inline-valid-params-invalid
      devices:
        - A
      steps:
        - tool: barrier
          device: A
          lock: sync-point
          deviceCount: 2
          params:
            deviceCount: 0
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "Effective (params) deviceCount=0 should be rejected even though inline is valid",
    )
  }

  @Test
  fun `rejects a barrier plan with no top-level devices declaration`() {
    // Mirrors the daemon's PlanValidator.validateMultiDeviceRequirements: a
    // barrier step is a multi-device coordination primitive, so a plan using
    // it must declare 'devices'. Without this check, IDE/JUnit validation
    // would bless a plan the daemon rejects at load time (#6215 review).
    val yaml =
      """
      name: barrier-no-devices-declared
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
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Barrier plan without a 'devices' declaration should be invalid")
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
  fun `rejects a barrier plan targeting device labels outside the declared devices set`() {
    // devices=[A,B] but the barrier steps target C/D: the distinct-device
    // count (2) would otherwise satisfy deviceCount=2, but C/D are not
    // declared devices at all, so this must be rejected regardless --
    // mirrors the daemon's PlanValidator.validateDeviceLabelsPresent.
    val yaml =
      """
      name: barrier-targets-undeclared-devices
      devices:
        - A
        - B
      steps:
        - tool: barrier
          params:
            device: C
            lock: sync-point
            deviceCount: 2
        - tool: barrier
          params:
            device: D
            lock: sync-point
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Barrier targeting undeclared device labels should be invalid")
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

  @Test
  fun `rejects a single device arriving more times than there are generations`() {
    // A, B, A, A with deviceCount=2: 4 arrivals is divisible by 2 (G=2), but
    // device A appears 3 times (greater than G=2) -- after generation 1
    // {A,B} releases, A's second arrival starts generation 2, but its third
    // arrival has no generation left to join.
    val yaml =
      """
      name: barrier-excess-single-device-arrivals
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
            device: A
            lock: sync-point
            deviceCount: 2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(
      result.valid,
      "Device A arriving 3 times with only 2 generations available should be invalid",
    )
  }

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
  fun `rejects a barrier step that omits device entirely under a declared devices set`() {
    // devices=[A]: one deviceCount=1 barrier step for this lock omits
    // 'device' altogether while another targets A. The device-less step
    // must be rejected, not silently ignored -- mirrors the daemon's
    // PlanValidator.validateDeviceLabelsPresent.
    val yaml =
      """
      name: barrier-missing-device
      devices:
        - A
      steps:
        - tool: barrier
          params:
            lock: sync-point
            deviceCount: 1
        - tool: barrier
          params:
            device: A
            lock: sync-point
            deviceCount: 1
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "A barrier step with no device label should be invalid")
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
  fun `validates expectations array`() {
    val yaml =
      """
      name: expectations-test
      steps:
        - tool: observe
          expectations:
            - type: elementExists
              selector:
                text: "Hello"
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Plan with expectations should be valid")
  }

  @Test
  fun `validates metadata fields`() {
    val yaml =
      """
      name: metadata-test
      steps:
        - tool: observe
      metadata:
        createdAt: "2026-01-08T00:00:00Z"
        version: "1.0.0"
        appId: com.example.app
        sessionId: "session-123"
        toolCallCount: 10
        duration: 1500.5
        generatedFromToolCalls: true
        experiments: ["exp-1", "exp-2"]
        treatments:
          exp-1: "variant-a"
        featureFlags:
          darkMode: true
          beta: false
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "Plan with metadata should be valid")
  }

  // ========== YAML Parsing Tests ==========

  @Test
  fun `reports YAML parse errors`() {
    val yaml =
      """
      name: test
      steps: [invalid
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Invalid YAML should not be valid")
    assertTrue(result.errors.isNotEmpty(), "Should have errors")
    assertEquals("root", result.errors[0].field)
    assertTrue(result.errors[0].message.contains("YAML parsing failed"))
  }

  // ========== Required Field Tests ==========

  @Test
  fun `reports missing required name field`() {
    val yaml =
      """
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.isNotEmpty())
    val nameError = result.errors.find { it.message.contains("name") }
    assertNotNull(nameError, "Should have error about missing name")
    assertTrue(nameError.message.contains("Missing required property"))
  }

  @Test
  fun `reports missing required steps field`() {
    val yaml =
      """
      name: test-plan
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    val stepsError = result.errors.find { it.message.contains("steps") }
    assertNotNull(stepsError, "Should have error about missing steps")
    assertTrue(stepsError.message.contains("Missing required property"))
  }

  @Test
  fun `reports empty name`() {
    val yaml =
      """
      name: ""
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.any { it.field.contains("name") })
  }

  @Test
  fun `reports empty steps array`() {
    val yaml =
      """
      name: test-plan
      steps: []
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.any { it.message.contains("at least 1") })
  }

  @Test
  fun `reports missing tool in step`() {
    val yaml =
      """
      name: test-plan
      steps:
        - params:
            foo: bar
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    val toolError = result.errors.find { it.message.contains("tool") }
    assertNotNull(toolError, "Should have error about missing tool")
    assertTrue(toolError.message.contains("Missing required property"))
  }

  @Test
  fun `reports empty tool name`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: ""
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.any { it.field.contains("tool") })
  }

  // ========== Type Validation Tests ==========

  @Test
  fun `reports wrong type for steps`() {
    val yaml =
      """
      name: test-plan
      steps: "not an array"
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "Plan with wrong type for steps should be invalid")
    assertTrue(result.errors.isNotEmpty(), "Should have at least one error")
    val hasStepsError =
      result.errors.any { error ->
        error.field.contains("steps", ignoreCase = true) ||
          error.message.contains("steps", ignoreCase = true) ||
          error.message.contains("array", ignoreCase = true)
      }
    assertTrue(
      hasStepsError,
      "Should have error related to steps being wrong type. Errors: ${result.errors}",
    )
  }

  // ========== Field Validation Tests ==========

  @Test
  fun `reports invalid mcpVersion format`() {
    val yaml =
      """
      name: test-plan
      mcpVersion: invalid-version
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.any { it.field.contains("mcpVersion") })
  }

  @Test
  fun `reports duplicate devices`() {
    val yaml =
      """
      name: test-plan
      devices:
        - A
        - A
      steps:
        - tool: observe
          params:
            device: A
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.any { it.field.contains("devices") })
  }

  @Test
  fun `reports empty device label`() {
    val yaml =
      """
      name: test-plan
      devices:
        - ""
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    assertTrue(result.errors.any { it.field.contains("devices") })
  }

  @Test
  fun `detects unknown property as error`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: observe
      unknownField: value
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "YAML with unknown property should fail validation")
    val unknownError = result.errors.find { it.message.contains("unknownField") }
    assertNotNull(unknownError, "Should report unknown property")
  }

  // ========== Deprecated Field Tests ==========

  @Test
  fun `allows deprecated generated field with warning`() {
    val yaml =
      """
      name: legacy-plan
      generated: "2026-01-08T00:00:00Z"
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    // Deprecated fields should still validate but may have warnings
    val warningErrors = result.errors.filter { it.severity == ValidationSeverity.WARNING }
    val hasDeprecatedWarning = warningErrors.any {
      it.message.contains("generated") || it.message.contains("deprecated")
    }
    assertTrue(
      hasDeprecatedWarning || result.valid,
      "Plan with deprecated 'generated' field should be valid or have warning",
    )
  }

  @Test
  fun `allows deprecated appId field with warning`() {
    val yaml =
      """
      name: legacy-plan
      appId: com.example.app
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    // Deprecated fields should still validate but may have warnings
    val warningErrors = result.errors.filter { it.severity == ValidationSeverity.WARNING }
    val hasDeprecatedWarning = warningErrors.any {
      it.message.contains("appId") || it.message.contains("deprecated")
    }
    assertTrue(
      hasDeprecatedWarning || result.valid,
      "Plan with deprecated 'appId' field should be valid or have warning",
    )
  }

  @Test
  fun `allows deprecated parameters field with warning`() {
    val yaml =
      """
      name: legacy-plan
      parameters:
        key1: value1
        key2: value2
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    // Deprecated fields should still validate but may have warnings
    val warningErrors = result.errors.filter { it.severity == ValidationSeverity.WARNING }
    val hasDeprecatedWarning = warningErrors.any {
      it.message.contains("parameters") || it.message.contains("deprecated")
    }
    assertTrue(
      hasDeprecatedWarning || result.valid,
      "Plan with deprecated 'parameters' field should be valid or have warning",
    )
  }

  @Test
  fun `allows deprecated description in steps with warning`() {
    val yaml =
      """
      name: legacy-plan
      steps:
        - tool: observe
          description: Old-style description
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    // Deprecated fields should still validate but may have warnings
    val warningErrors = result.errors.filter { it.severity == ValidationSeverity.WARNING }
    val hasDeprecatedWarning = warningErrors.any {
      it.message.contains("description") || it.message.contains("deprecated")
    }
    assertTrue(
      hasDeprecatedWarning || result.valid,
      "Plan with deprecated step 'description' should be valid or have warning",
    )
  }

  // ========== Tool Name Validation Tests ==========

  @Test
  fun `detects invalid tool name`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: invalidTool
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "YAML with invalid tool should fail validation")
    val toolError =
      result.errors.find {
        it.message.contains("Unknown tool") && it.message.contains("invalidTool")
      }
    assertNotNull(toolError, "Should report unknown tool")
  }

  @Test
  fun `accepts valid tool names`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: observe
        - tool: tapOn
          params:
            text: button
        - tool: launchApp
          params:
            appId: com.example.app
        - tool: crashApp
          params:
            appId: com.example.app
        - tool: setAppPermissions
          params:
            appId: com.example.app
            permissions:
              - camera
        - tool: getAppPermissions
          params:
            appId: com.example.app
        - tool: getDeviceState
          params:
            include:
              - doNotDisturb
        - tool: setDeviceState
          params:
            doNotDisturb:
              mode: priority
        - tool: getNotificationPolicy
          params:
            appId: com.example.app
        - tool: setNotificationPolicy
          params:
            appId: com.example.app
            policyAccess: true
        - tool: setAppPermissions
          params:
            appId: com.example.app
            action: revoke
            permissions:
              - camera
        - tool: setAppPermissions
          params:
            appId: com.example.app
            notificationsEnabled: true
        - tool: getAppPermissions
          params:
            appId: com.example.app
            permissions:
              - camera
        - tool: provisionDevice
        - tool: stageSharedStorage
        - tool: deleteDevice
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "YAML with valid tools should pass validation: ${result.errors}")
  }

  @Test
  fun `rejects reset with userId`() {
    val yaml =
      """
      name: invalid-reset-user
      steps:
        - tool: setAppPermissions
          params:
            appId: com.example.app
            action: reset
            permissions:
              - all
            userId: 10
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)

    assertFalse(result.valid, "Android reset must reject userId: ${result.errors}")
  }

  @Test
  fun `rejects reset without permissions`() {
    val yaml =
      """
      name: invalid-reset-without-permissions
      steps:
        - tool: setAppPermissions
          params:
            appId: com.example.app
            action: reset
            notificationsEnabled: false
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)

    assertFalse(result.valid, "Reset must require permissions: ${result.errors}")
  }

  @Test
  fun `rejects Android reset without all permissions`() {
    val yaml =
      """
      name: invalid-android-reset-scope
      steps:
        - tool: setAppPermissions
          params:
            appId: com.example.app
            action: reset
            platform: android
            permissions:
              - camera
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)

    assertFalse(result.valid, "Android reset must require permissions=['all']: ${result.errors}")
  }

  @Test
  fun `accepts accessibilityFocus tool published in generated definitions`() {
    val yaml =
      """
      name: accessibility-focus-plan
      steps:
        - tool: accessibilityFocus
          params:
            resourceId: login_button
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "accessibilityFocus should be accepted: ${result.errors}")
  }

  @Test
  fun `detects multiple invalid tool names`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: invalidTool1
        - tool: observe
        - tool: invalidTool2
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "YAML with invalid tools should fail validation")
    val tool1Error = result.errors.find { it.message.contains("invalidTool1") }
    val tool2Error = result.errors.find { it.message.contains("invalidTool2") }
    assertNotNull(tool1Error, "Should report first invalid tool")
    assertNotNull(tool2Error, "Should report second invalid tool")
  }

  // ========== Tool Parameter Validation Tests ==========

  @Test
  fun `validates dragAndDrop params in params object`() {
    val yaml =
      """
      name: drag-and-drop
      steps:
        - tool: dragAndDrop
          params:
            source:
              text: Source
            target:
              elementId: target-id
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(result.valid, "dragAndDrop with valid params should be valid: ${result.errors}")
  }

  @Test
  fun `reports missing dragAndDrop target`() {
    val yaml =
      """
      name: drag-and-drop
      steps:
        - tool: dragAndDrop
          params:
            source:
              text: Source
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "dragAndDrop without target should be invalid")
    assertTrue(
      result.errors.any { error ->
        error.field.contains("target", ignoreCase = true) ||
          error.message.contains("target", ignoreCase = true)
      },
      "Should report missing target: ${result.errors}",
    )
  }

  @Test
  fun `reports dragAndDrop source with both text and elementId`() {
    val yaml =
      """
      name: drag-and-drop
      steps:
        - tool: dragAndDrop
          params:
            source:
              text: Source
              elementId: source-id
            target:
              text: Target
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid, "dragAndDrop source should require exactly one selector")
    assertTrue(
      result.errors.any { error ->
        error.field.contains("source", ignoreCase = true) ||
          error.message.contains("source", ignoreCase = true)
      },
      "Should report invalid source selector: ${result.errors}",
    )
  }

  @Test
  fun `validates dragAndDrop with top-level selectors and param overrides`() {
    val yaml =
      """
      name: drag-and-drop
      steps:
        - tool: dragAndDrop
          source:
            text: Source
          target:
            text: Target
          params:
            dragDurationMs: 800
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertTrue(
      result.valid,
      "dragAndDrop with top-level selectors should be valid: ${result.errors}",
    )
  }

  // ========== Error Reporting Tests ==========

  @Test
  fun `provides line numbers when possible`() {
    val invalidYaml =
      """
      steps:
        - tool: observe
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(invalidYaml)
    assertFalse(result.valid)
    // Line numbers are best-effort, so we just verify the structure is correct
    result.errors.forEach { error ->
      assertNotNull(error.field)
      assertNotNull(error.message)
      // line and column may be null, which is acceptable
    }
  }

  @Test
  fun `formats field paths nicely`() {
    val yaml =
      """
      name: test-plan
      steps:
        - tool: observe
        - {}
      """
        .trimIndent()

    val result = TestPlanValidator.validateYaml(yaml)
    assertFalse(result.valid)
    // Should have error for steps[1] missing tool
    val error = result.errors.find { it.field.contains("steps") }
    assertNotNull(error, "Should have error about steps")
  }
}
