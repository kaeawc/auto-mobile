package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import java.io.File
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

class PrototypeRenderMapperTest {
  private fun spec(root: PrototypeNode, a: Boolean = false) =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      mapOf("a" to PrototypeScalar.BooleanValue(a)),
      root,
    )

  @Test
  fun `state changes retain independent subtrees and unchanged dependent children`() {
    val condition = PrototypeCondition("a", PrototypeScalar.BooleanValue(true))
    val dependent =
      PrototypeColumnNode(
        visibleWhen = condition,
        styleWhen = listOf(PrototypeStyleWhen(condition, PrototypeStyle(alpha = 0.5))),
        children =
          listOf(
            PrototypeTextNode(text = "{a}"),
            PrototypeSwitchNode(stateKey = "a"),
            PrototypeTextNode(text = "constant"),
          ),
      )
    val input =
      spec(
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeBoxNode(children = listOf(PrototypeTextNode(text = "left"))),
              dependent,
              PrototypeRowNode(children = listOf(PrototypeTextNode(text = "right"))),
            ),
        ),
      )
    val mapper = PrototypeRenderMapper()
    val before = mapper.map(input, emptyMap()).root
    val changed = input.copy(state = mapOf("a" to PrototypeScalar.BooleanValue(true)))
    val after = mapper.map(changed, emptyMap()).root
    assertSame(before.children[0], after.children[0])
    assertSame(before.children[2], after.children[2])
    assertNotSame(before.children[1], after.children[1])
    assertNotSame(before.children[1].children[0], after.children[1].children[0])
    assertNotSame(before.children[1].children[1], after.children[1].children[1])
    assertSame(before.children[1].children[2], after.children[1].children[2])
    assertEquals(mapPrototypeSpec(changed), mapper.map(changed, emptyMap()))
  }

  @Test
  fun `pager state is scoped to each pager and retains static pages and outside siblings`() {
    val pager =
      PrototypePagerNode(
        "pages",
        children =
          listOf(
            PrototypeColumnNode(
              children =
                listOf(
                  PrototypeTextNode(text = "{page} of {pageCount}"),
                  PrototypeTextNode(text = "static"),
                  PrototypePagerNode(
                    "nested",
                    children = listOf(PrototypeTextNode(text = "{page}")),
                  ),
                ),
            ),
            PrototypeTextNode(text = "static page"),
          ),
      )
    val input =
      spec(PrototypeColumnNode(children = listOf(pager, PrototypeTextNode(text = "{page}"))))
    val mapper = PrototypeRenderMapper()
    val before = mapper.map(input, mapOf("pages" to 0)).root
    val after = mapper.map(input, mapOf("pages" to 1)).root
    assertSame(before.children[1], after.children[1])
    assertNotSame(before.children[0], after.children[0])
    val oldPage = before.children[0].children[0]
    val newPage = after.children[0].children[0]
    assertNotSame(oldPage.children[0], newPage.children[0])
    assertEquals("2 of 2", newPage.children[0].text)
    assertSame(oldPage.children[1], newPage.children[1])
    assertSame(oldPage.children[2], newPage.children[2])
    assertSame(before.children[0].children[1], after.children[0].children[1])
    assertEquals(
      mapPrototypeSpec(input, mapOf("pages" to 1)),
      mapper.map(input, mapOf("pages" to 1)),
    )
  }

  @Test
  fun `repeat rows retain their bound source style and children instances`() {
    val rows =
      PrototypeColumnNode(
        repeat = PrototypeRepeat(listOf(mapOf("label" to PrototypeScalar.Text("row"))), "item"),
        children =
          listOf(PrototypeRowNode(children = listOf(PrototypeTextNode(text = "{item.label}")))),
      )
    val input = spec(PrototypeColumnNode(children = listOf(rows, PrototypeTextNode(text = "{a}"))))
    val mapper = PrototypeRenderMapper()
    val before = mapper.map(input, emptyMap()).root.children[0]
    val after =
      mapper
        .map(input.copy(state = mapOf("a" to PrototypeScalar.BooleanValue(true))), emptyMap())
        .root
        .children[0]
    assertSame(before, after)
    assertSame(before.children, after.children)
    assertSame(before.children[0].source, after.children[0].source)
    assertSame(before.children[0].style, after.children[0].style)
  }

  @Test
  fun `equal snapshots and no-op writes retain the model without mapping`() {
    val input = spec(PrototypeTextNode(text = "{a}"))
    val mapper = PrototypeRenderMapper()
    val before = mapper.map(input, emptyMap())
    assertSame(before, mapper.map(input, emptyMap()))
    assertSame(before, mapper.map(input.copy(state = input.state?.toMap()), emptyMap()))
    assertEquals(1, mapper.mappingPasses)
    val unusedWrite =
      input.copy(state = input.state.orEmpty() + ("unused" to PrototypeScalar.Text("x")))
    assertSame(before.root, mapper.map(unusedWrite, emptyMap()).root)
    assertEquals(2, mapper.mappingPasses)
  }

  @Test
  fun `root replacement interns equal source nodes but respects changed source fields`() {
    val root = PrototypeColumnNode(children = listOf(PrototypeTextNode(text = "same")))
    val mapper = PrototypeRenderMapper()
    val before = mapper.map(spec(root), emptyMap())
    val replacement = root.copy(children = listOf((root.children[0] as PrototypeTextNode).copy()))
    assertSame(before.root, mapper.map(spec(replacement), emptyMap()).root)
    val altered =
      replacement.copy(
        children =
          listOf(PrototypeTextNode(text = "same", onTap = listOf(PrototypeEmitAction("tap")))),
      )
    val after = mapper.map(spec(altered), emptyMap())
    assertNotSame(before.root.children[0], after.root.children[0])
    assertEquals(mapPrototypeSpec(spec(altered)), after)
  }

  @Test
  fun `first mapping preserves node depth and size guard errors exactly`() {
    val limit = PrototypeSpecValidator.MAX_PROTOTYPE_NODES
    val tooMany = PrototypeBoxNode(children = List(limit) { PrototypeSpacerNode() })
    fun nested(depth: Int): PrototypeNode =
      if (depth == 1) PrototypeSpacerNode()
      else PrototypeBoxNode(children = listOf(nested(depth - 1)))
    val roots =
      listOf(
        tooMany,
        nested(PrototypeSpecValidator.MAX_PROTOTYPE_DEPTH + 1),
        PrototypeTextNode(
          text = "size",
          style = PrototypeStyle(width = PrototypeDimension.Dp(Double.MAX_VALUE)),
        ),
        PrototypeTextNode(
          text = "conditional",
          styleWhen =
            listOf(
              PrototypeStyleWhen(
                PrototypeCondition("a", PrototypeScalar.BooleanValue(true)),
                PrototypeStyle(letterSpacing = Double.NaN),
              ),
            ),
        ),
      )
    for (root in roots) {
      val expected =
        assertThrows(IllegalArgumentException::class.java) { mapPrototypeSpec(spec(root)) }
      val actual =
        assertThrows(IllegalArgumentException::class.java) {
          PrototypeRenderMapper().map(spec(root), emptyMap())
        }
      assertEquals(expected.message, actual.message)
    }
  }
}

/** Each shared fixture gets its own small differential test, including all its authored state. */
@RunWith(Parameterized::class)
class PrototypeRenderMapperFixtureTest(private val name: String, private val input: PrototypeSpec) {
  companion object {
    @JvmStatic
    @Parameterized.Parameters(name = "{0}")
    fun fixtures(): List<Array<Any>> {
      val directory =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-spec/valid") }
          .first { it.isDirectory }
      return checkNotNull(directory.listFiles())
        .filter { it.extension == "json" }
        .sortedBy { it.name }
        .map { file ->
          val validated =
            PrototypeSpecValidator.validate(file.readText()) as PrototypeSpecValidation.Success
          arrayOf(file.name, validated.spec)
        }
    }
  }

  @Test
  fun `incremental mapping equals fresh mapping after writes pages and runtime replacement`() {
    val runtime = PrototypeRuntime(input, nextSequence = { 1L })
    fun compare() {
      assertEquals(
        name,
        mapPrototypeSpec(runtime.current.spec, runtime.current.pages),
        runtime.renderModel(),
      )
    }
    compare()
    for ((key, value) in input.state.orEmpty()) {
      val next =
        when (value) {
          is PrototypeScalar.BooleanValue -> PrototypeScalar.BooleanValue(!value.value)
          is PrototypeScalar.Numeric -> PrototypeScalar.Numeric(value.value + 1)
          is PrototypeScalar.Text -> PrototypeScalar.Text("${value.value} changed")
        }
      runtime.replace(runtime.current.spec.copy(state = runtime.current.state + (key to next)))
      compare()
    }
    val mapper = PrototypeRenderMapper()
    fun pages(node: PrototypeNode, path: String) {
      if (node is PrototypePagerNode) {
        for (page in node.children.indices) {
          val selected = mapOf(node.id to page)
          assertEquals(
            name,
            mapPrototypeSpec(runtime.current.spec, selected),
            mapper.map(runtime.current.spec, selected),
          )
        }
      }
      prototypeChildEntries(node, path).forEach { pages(it.node, it.path) }
    }
    pages(runtime.current.spec.root, "root")
    val replacement =
      Json.decodeFromString<PrototypeSpec>(Json.encodeToString(runtime.current.spec))
    runtime.replace(replacement)
    compare()
  }
}
