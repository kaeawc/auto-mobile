package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import dev.jasonpearson.automobile.protocol.PrototypeModeValue
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeStyle
import dev.jasonpearson.automobile.prototype.fixtureFile
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure behaviour of `style.effects` (#15129), driven by the shared contract fixtures. */
class PrototypeEffectsTest {
  private val allTypes by lazy { fixture("z-effects-all-types.json") }
  private val styles: List<PrototypeStyle> by lazy {
    allTypes.let { spec ->
      val children =
        (spec.root as dev.jasonpearson.automobile.protocol.PrototypeColumnNode).children
      children.mapNotNull { it.style }
    }
  }
  private val effects by lazy { styles.flatMap { it.effects.orEmpty() } }

  private fun fixture(name: String): PrototypeSpec =
    when (
      val result =
        PrototypeSpecValidator.validate(
          fixtureFile("prototype-spec/valid/$name").readText(),
        )
    ) {
      is PrototypeSpecValidation.Success -> result.spec
      is PrototypeSpecValidation.Failure -> error("$name: ${result.error}")
    }

  @Test
  fun `the fixture covers all ten effects and each one decodes`() {
    val parsed = effects.map { checkNotNull(prototypeParseEffect(it)) }
    assertEquals(
      setOf(
        "noise",
        "gradientMesh",
        "shimmer",
        "glow",
        "vignette",
        "blur",
        "pixelate",
        "chromaticAberration",
        "wave",
        "ripple",
      ),
      parsed.map { it.type }.toSet(),
    )
    assertEquals(10, parsed.size)
  }

  @Test
  fun `omitted params take the conservative defaults`() {
    val glow =
      prototypeParseEffect(
        buildJsonObject {
          put("type", "glow")
          put("color", "primary")
        },
      )
    assertEquals(12f, (glow as PrototypeEffect.Glow).radiusDp, 0f)
    assertEquals(0.6f, glow.intensity, 0f)
    val vignette = prototypeParseEffect(buildJsonObject { put("type", "vignette") })
    assertEquals(null, (vignette as PrototypeEffect.Vignette).color)
    assertEquals(0.4f, vignette.intensity, 0f)
    val ripple =
      prototypeParseEffect(buildJsonObject { put("type", "ripple") }) as PrototypeEffect.Ripple
    assertEquals(0.5f to 0.5f, ripple.centerX to ripple.centerY)
  }

  @Test
  fun `API floors decide what is drawn and what is reported as degraded`() {
    fun drawn(sdk: Int) = prototypeEffectPlan(effects, sdk).drawn.map { it.type }.toSet()
    fun omitted(sdk: Int) = prototypeEffectPlan(effects, sdk).omitted.map { it.value.type }.toSet()
    // Below 31 only the brush-based looks draw.
    assertEquals(setOf("shimmer", "glow", "vignette"), drawn(30))
    assertEquals(
      setOf("noise", "gradientMesh", "blur", "pixelate", "chromaticAberration", "wave", "ripple"),
      omitted(30),
    )
    // 31 adds blur; the AGSL effects wait for 33.
    assertEquals(setOf("shimmer", "glow", "vignette", "blur"), drawn(31))
    assertTrue("noise" in omitted(32))
    assertEquals(10, drawn(33).size)
    assertTrue(omitted(33).isEmpty())
    assertTrue(omitted(36).isEmpty())
  }

  @Test
  fun `an API 30 device reports each omitted effect at its node and authored index`() {
    val root = mapPrototypeSpec(allTypes).root
    val ids = root.children.map { it.identity }
    val report = prototypeDegradedEffects(root, 30)
    assertEquals(
      listOf(
        prototypeEffectPath(ids[0], 0) to "noise",
        prototypeEffectPath(ids[0], 1) to "gradientMesh",
        prototypeEffectPath(ids[2], 0) to "blur",
        prototypeEffectPath(ids[2], 1) to "pixelate",
        prototypeEffectPath(ids[2], 2) to "chromaticAberration",
        prototypeEffectPath(ids[3], 0) to "wave",
        prototypeEffectPath(ids[3], 1) to "ripple",
      ),
      report.map { it.path to it.type },
    )
    assertTrue(report.all { it.reason == "api" })
    assertTrue(prototypeDegradedEffects(root, 33).isEmpty())
  }

  @Test
  fun `the authored index survives an omitted earlier effect`() {
    // On API 31 the noise (index 0) is omitted, so the shimmer after it is drawn as index 1.
    val raw = effects.filter { it["type"].toString() in setOf("\"noise\"", "\"shimmer\"") }
    val plan = prototypeEffectPlan(raw, 31)
    assertEquals(listOf(1), plan.indexed.map { it.index })
    assertEquals(listOf(0), plan.omitted.map { it.index })
  }

  @Test
  fun `the report follows the styleWhen style in force`() {
    val spec = fixture("z-effects-style-when.json")
    val report = prototypeDegradedEffects(mapPrototypeSpec(spec).root, 30)
    assertTrue(report.isNotEmpty())
    assertTrue(report.all { it.path.contains(".style.effects[") })
  }

  @Test
  fun `only shimmer wave and ripple cycle, and phase is the authored one without animate`() {
    val cycling = effects.mapNotNull(::prototypeParseEffect).filter { it.cycles }.map { it.type }
    assertEquals(setOf("shimmer", "wave", "ripple"), cycling.toSet())
    assertEquals(0.25f, prototypeEffectPhase(0.25f, null, 9_000_000_000L), 0f)
    // A 1000 ms loop is half way after 500 ms, and wraps.
    assertEquals(0.5f, prototypeEffectPhase(0f, 1000, 500_000_000L), 1e-6f)
    assertEquals(0.75f, prototypeEffectPhase(0.25f, 1000, 1_500_000_000L), 1e-6f)
  }

  @Test
  fun `colours resolve like style color across roles hex and light dark pairs`() {
    val light = PrototypePalette(lightColorScheme(), dark = false)
    val dark = PrototypePalette(darkColorScheme(), dark = true)
    assertEquals(
      light.scheme.primary,
      prototypeEffectColor(light, PrototypeModeValue.Single("primary")),
    )
    assertEquals(
      dark.scheme.primary,
      prototypeEffectColor(dark, PrototypeModeValue.Single("primary")),
    )
    assertEquals(
      Color(0xFF112233),
      prototypeEffectColor(light, PrototypeModeValue.Single("#112233")),
    )
    val pair = PrototypeModeValue.Modes("#FFFFFF", "#000000")
    assertEquals(Color.White, prototypeEffectColor(light, pair))
    assertEquals(Color.Black, prototypeEffectColor(dark, pair))
    // The scrim role is the scheme's own colour here, not the dimming scrim alpha.
    assertEquals(
      light.scheme.scrim,
      prototypeEffectColor(light, PrototypeModeValue.Single("scrim")),
    )
  }

  @Test
  fun `a noise seed always picks the same distinct pattern`() {
    assertEquals(prototypeNoiseSeedOffset(7), prototypeNoiseSeedOffset(7))
    assertNotEquals(prototypeNoiseSeedOffset(7), prototypeNoiseSeedOffset(8))
    assertNotEquals(prototypeNoiseSeedOffset(0), prototypeNoiseSeedOffset(256))
  }

  // --- the frame clock and the budget guard, on a fake frame source: no real time passes ---

  private class FakeFrames(private val times: List<Long>) : PrototypeFrameSource {
    private var next = 0

    override suspend fun nextFrameNanos(): Long? = times.getOrNull(next++)
  }

  private fun frames(count: Int, stepMs: Long) = List(count) { it * stepMs * 1_000_000L }

  private fun elapsedAfter(motion: Boolean, frameTimes: List<Long>, visible: Boolean = true): Long {
    var elapsed = 0L
    runBlocking {
      PrototypeEffectClock(FakeFrames(frameTimes), PrototypeEffectBudget(onDegraded = {})).run(
        { motion },
        { visible },
      ) {
        elapsed = it
      }
    }
    return elapsed
  }

  @Test
  fun `the clock advances with motion on and freezes under motion none or scale 0`() {
    val ticks = frames(5, 16)
    assertEquals(64_000_000L, elapsedAfter(prototypeMotionEnabled("auto", 1f), ticks))
    assertEquals(0L, elapsedAfter(prototypeMotionEnabled("none", 1f), ticks))
    assertEquals(0L, elapsedAfter(prototypeMotionEnabled(null, 0f), ticks))
    // Hidden prototypes do not advance either.
    assertEquals(0L, elapsedAfter(true, ticks, visible = false))
  }

  @Test
  fun `frozen means the phase stays at the authored one`() {
    val frozen = elapsedAfter(prototypeMotionEnabled("none", 1f), frames(60, 16))
    assertEquals(0.3f, prototypeEffectPhase(0.3f, 2000, frozen), 1e-6f)
    val running = elapsedAfter(true, frames(60, 16))
    assertNotEquals(0.3f, prototypeEffectPhase(0.3f, 2000, running), 1e-3f)
  }

  @Test
  fun `thirty slow frames in a row fire exactly one degraded callback and stop the clock`() {
    var fired = 0
    var published = 0
    // 60 frames 40 ms apart: every delta after the first is over the 32 ms budget.
    val ticks = frames(60, 40)
    runBlocking {
      PrototypeEffectClock(FakeFrames(ticks), PrototypeEffectBudget(onDegraded = { fired++ })).run(
        { true },
        { true },
      ) {
        published++
      }
    }
    assertEquals(1, fired)
    // The first frame has no delta and publishes; the 30th slow frame degrades the clock and does
    // not.
    assertEquals(30, published)
  }

  @Test
  fun `one fast frame resets the slow run and a steady 60 Hz never degrades`() {
    var fired = 0
    val budget = PrototypeEffectBudget(onDegraded = { fired++ })
    repeat(29) { budget.record(40_000_000L) }
    budget.record(16_000_000L)
    repeat(29) { budget.record(40_000_000L) }
    assertEquals(0, fired)
    assertFalse(budget.degraded)
    budget.record(40_000_000L)
    assertEquals(1, fired)
    repeat(10) { budget.record(40_000_000L) }
    assertEquals(1, fired)
  }

  @Test
  fun `the health report lists a frozen effect once and drops it when cleared`() {
    val health = PrototypeEffectHealth()
    health.markBudget("root.child.style.effects[0]", "wave")
    health.markBudget("root.child.style.effects[0]", "wave")
    assertEquals(
      listOf("root.child.style.effects[0]" to "budget"),
      health.snapshot().map { it.path to it.reason },
    )
    health.clear("root.child.style.effects[0]")
    assertTrue(health.snapshot().isEmpty())
  }

  @Test
  fun `a resumed clock continues from where it stopped`() {
    var elapsed = 0L
    runBlocking {
      PrototypeEffectClock(FakeFrames(frames(3, 16)), PrototypeEffectBudget(onDegraded = {})).run(
        { true },
        { true },
        startNanos = 500_000_000L,
      ) {
        elapsed = it
      }
    }
    assertEquals(532_000_000L, elapsed)
  }
}
