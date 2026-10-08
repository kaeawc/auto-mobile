package dev.jasonpearson.automobile.ide.yaml

import dev.jasonpearson.automobile.ide.yaml.PathSegment.Index
import dev.jasonpearson.automobile.ide.yaml.PathSegment.Key
import dev.jasonpearson.automobile.validation.TestPlanValidator
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test
import org.yaml.snakeyaml.Yaml

class TestPlanErrorPathTest {

  @Test
  fun `parses every path form the shared validator emits`() {
    val cases =
      mapOf(
        "root" to emptyList(),
        "" to emptyList(),
        "name" to listOf(Key("name")),
        "steps" to listOf(Key("steps")),
        "devices" to listOf(Key("devices")),
        "steps[1]" to listOf(Key("steps"), Index(1)),
        "steps[3].tool" to listOf(Key("steps"), Index(3), Key("tool")),
        "steps[12].tool" to listOf(Key("steps"), Index(12), Key("tool")),
        "steps[0].steps[1]" to listOf(Key("steps"), Index(0), Key("steps"), Index(1)),
        "steps[2].steps[0].params.text" to
          listOf(Key("steps"), Index(2), Key("steps"), Index(0), Key("params"), Key("text")),
        "steps[4].params.clock.instant" to
          listOf(Key("steps"), Index(4), Key("params"), Key("clock"), Key("instant")),
        "steps[4].clock.instant" to listOf(Key("steps"), Index(4), Key("clock"), Key("instant")),
        "[0]" to listOf(Index(0)),
        "a[0][1]" to listOf(Key("a"), Index(0), Index(1)),
      )

    for ((field, expected) in cases) {
      assertEquals(expected, TestPlanErrorPath.parse(field), "parse(\"$field\")")
    }
  }

  @Test
  fun `rejects malformed paths instead of guessing`() {
    val malformed =
      listOf(
        ".steps",
        "steps.",
        "steps..tool",
        "steps[",
        "steps[]",
        "steps[x]",
        "steps[-1]",
        "steps[1]tool",
        "steps[99999999999]",
        "steps]1[",
      )

    for (field in malformed) {
      assertNull(TestPlanErrorPath.parse(field), "parse(\"$field\") should be null")
    }
  }

  @Test
  fun `a key containing a dot is split and so does not resolve`() {
    // The validator does not escape dots, so `params.a.b` is indistinguishable from nested keys.
    val segments = TestPlanErrorPath.parse("steps[0].params.a.b")
    assertEquals(
      listOf(Key("steps"), Index(0), Key("params"), Key("a"), Key("b")),
      segments,
    )
    val tree = parseTree("name: p\nsteps:\n  - tool: tapOn\n    params:\n      a.b: 1\n")
    assertEquals(PathResolution.Unresolved, resolvePath(tree, segments!!, MapTree))
  }

  @Test
  fun `identifies a step path`() {
    assertTrue(TestPlanErrorPath.isStepPath(TestPlanErrorPath.parse("steps[2]")!!))
    assertFalse(TestPlanErrorPath.isStepPath(TestPlanErrorPath.parse("steps[2].tool")!!))
    assertFalse(TestPlanErrorPath.isStepPath(TestPlanErrorPath.parse("root")!!))
    assertFalse(TestPlanErrorPath.isStepPath(TestPlanErrorPath.parse("steps")!!))
    assertFalse(TestPlanErrorPath.isStepPath(TestPlanErrorPath.parse("steps[0].steps[1]")!!))
  }

  @Test
  fun `first line end stops at the first newline`() {
    assertEquals(3, firstLineEnd("abc\ndef"))
    assertEquals(3, firstLineEnd("abc"))
    assertEquals(0, firstLineEnd(""))
    assertEquals(0, firstLineEnd("\nx"))
  }

  // -- resolution over a snakeyaml-backed tree, driven by real validator output --

  private val fourStepPlan =
    """
    name: demo
    steps:
      - tool: launchApp
        params:
          appId: com.example
      - tool: observe
      - tool: tapOn
        params:
          text: Login
      - tool: tapOnn
        params:
          text: Login
    """
      .trimIndent()

  @Test
  fun `an unknown tool at step 3 resolves to step 3, not the first tool key`() {
    val errors = TestPlanValidator.validateYaml(fourStepPlan).errors
    val error = errors.single { it.message.startsWith("Unknown tool") }
    assertEquals("steps[3].tool", error.field)

    val resolution = resolve(fourStepPlan, error.field)

    assertEquals(PathResolution.Found("tapOnn"), resolution)
  }

  @Test
  fun `a step missing tool resolves to that step mapping`() {
    val plan =
      """
      name: demo
      steps:
        - tool: launchApp
        - params:
            text: Login
        - tool: tapOn
      """
        .trimIndent()
    val error = TestPlanValidator.validateYaml(plan).errors.single()
    assertEquals("steps[1]", error.field)
    assertTrue(error.message.contains("Missing required property 'tool'"))

    val resolution = resolve(plan, error.field)

    assertEquals(PathResolution.Found(mapOf("params" to mapOf("text" to "Login"))), resolution)
  }

  @Test
  fun `a nested step missing tool resolves inside the parent step`() {
    val plan =
      """
      name: demo
      devices:
        - a
        - b
      steps:
        - tool: observe
        - tool: criticalSection
          lock: l
          deviceCount: 2
          params:
            lock: l
            deviceCount: 2
          steps:
            - tool: observe
            - params:
                text: nested
      """
        .trimIndent()
    val error =
      TestPlanValidator.validateYaml(plan).errors.single {
        it.message.contains("Missing required property 'tool'")
      }
    assertEquals("steps[1].steps[1]", error.field)

    val resolution = resolve(plan, error.field)

    assertEquals(PathResolution.Found(mapOf("params" to mapOf("text" to "nested"))), resolution)
  }

  @Test
  fun `a plan level error resolves to the document root`() {
    val plan = "steps:\n  - tool: observe\n"
    val error = TestPlanValidator.validateYaml(plan).errors.single()
    assertEquals("root", error.field)

    val resolution = resolve(plan, error.field)

    assertEquals(
      PathResolution.Found(mapOf("steps" to listOf(mapOf("tool" to "observe")))),
      resolution,
    )
  }

  @Test
  fun `every error the validator reports for the sample plans resolves`() {
    val plans =
      listOf(
        fourStepPlan,
        "name: demo\nsteps:\n  - tool: 5\n  - tool: observe\n",
        "name: demo\ngenerated: x\nparameters: z\nsteps:\n  - tool: observe\n",
        "name: demo\nunknownTop: 1\nsteps:\n  - tool: observe\n",
      )

    for (plan in plans) {
      for (error in TestPlanValidator.validateYaml(plan).errors) {
        val resolution = resolve(plan, error.field)
        assertTrue(
          resolution is PathResolution.Found<*>,
          "'${error.field}' (${error.message}) did not resolve: $resolution",
        )
      }
    }
  }

  @Test
  fun `a missing final key reports its ancestor, never a same-named key elsewhere`() {
    val plan = "name: demo\nsteps:\n  - tool: observe\n  - tool: tapOn\n"

    val resolution = resolve(plan, "steps[1].params")

    assertEquals(PathResolution.MissingKey(mapOf("tool" to "tapOn"), "params"), resolution)
  }

  @Test
  fun `a stale path is unresolved`() {
    val plan = "name: demo\nsteps:\n  - tool: observe\n"

    assertEquals(PathResolution.Unresolved, resolve(plan, "steps[5].tool"))
    assertEquals(PathResolution.Unresolved, resolve(plan, "steps[0].tool.x"))
    assertEquals(PathResolution.Unresolved, resolve(plan, "devices.x"))
    assertEquals(PathResolution.Unresolved, resolve(plan, "name[0]"))
  }

  @Test
  fun `the walk never searches by name across the file`() {
    // `tool` exists only in step 0; a name search for steps[1].tool would wrongly find it.
    val plan = "name: demo\nsteps:\n  - tool: launchApp\n  - params: {}\n"

    val resolution = resolve(plan, "steps[1].tool")

    assertEquals(
      PathResolution.MissingKey(mapOf("params" to emptyMap<String, Any>()), "tool"),
      resolution,
    )
  }

  private fun resolve(plan: String, field: String): PathResolution<Any?> {
    val segments = TestPlanErrorPath.parse(field) ?: return PathResolution.Unresolved
    return resolvePath(parseTree(plan), segments, MapTree)
  }

  private fun parseTree(plan: String): Any? = Yaml().load<Any?>(plan)

  /** Minimal [YamlPathTree] over snakeyaml's Map/List output, mirroring the PSI adapter's rules. */
  private object MapTree : YamlPathTree<Any?> {
    override fun child(parent: Any?, segment: PathSegment): ChildLookup<Any?> =
      when (segment) {
        is Key ->
          when (parent) {
            is Map<*, *> ->
              if (parent.containsKey(segment.name)) ChildLookup.Found(parent[segment.name])
              else ChildLookup.KeyAbsent
            else -> ChildLookup.NotFound
          }
        is Index ->
          when (parent) {
            is List<*> ->
              if (segment.index in parent.indices) ChildLookup.Found(parent[segment.index])
              else ChildLookup.NotFound
            else -> ChildLookup.NotFound
          }
      }
  }
}
