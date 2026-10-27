package dev.jasonpearson.automobile.buildlogic.r8

import java.io.StringReader
import javax.xml.parsers.DocumentBuilderFactory
import org.objectweb.asm.AnnotationVisitor
import org.objectweb.asm.ClassReader
import org.objectweb.asm.ClassVisitor
import org.objectweb.asm.Opcodes
import org.w3c.dom.Element
import org.xml.sax.InputSource

/** Pure analysis of pre-R8 bytecode, merged manifest XML and R8's mapping format. */
object R8KeptClasses {
  data class Result(
    val manifestComponents: List<String>,
    val manifestReferencedClasses: List<String>,
    val serializableClasses: List<String>,
    val serializers: List<String>,
    val sentinels: List<String>,
    val violations: List<String>,
  ) {
    val counts: String
      get() =
        "${manifestComponents.size} manifest components, " +
          "${manifestReferencedClasses.size} manifest-referenced classes, " +
          "${serializableClasses.size} @Serializable classes, ${serializers.size} serializers, " +
          "${sentinels.size} reflective members"

    fun report(): String = buildString {
      appendLine("R8 kept classes: $counts")
      for ((category, names) in
        listOf(
          "Manifest components" to manifestComponents,
          "Manifest-referenced classes" to manifestReferencedClasses,
          "@Serializable classes" to serializableClasses,
          "Serializers" to serializers,
          "Reflective members" to sentinels,
          "Violations" to violations,
        )) {
        appendLine()
        appendLine("$category (${names.size}):")
        names.forEach { appendLine(it) }
      }
    }
  }

  fun analyze(
    mappingText: String,
    manifestXml: String,
    namespace: String,
    classBytes: Sequence<ByteArray>,
    ownedPackagePrefixes: List<String>,
    requiredMembers: List<String>,
    keptSerializablePrefixes: List<String> = ownedPackagePrefixes,
  ): Result {
    val (components, referencedClasses) = manifestClasses(manifestXml, namespace)
    val ownedClasses = mutableSetOf<String>()
    val serializable = sortedSetOf<String>()
    for (bytes in classBytes) {
      val reader = ClassReader(bytes)
      if (ownedPackagePrefixes.none { reader.className.startsWith(it) }) continue
      val name = reader.className.replace('/', '.')
      ownedClasses.add(name)
      reader.accept(
        object : ClassVisitor(Opcodes.ASM9) {
          override fun visitAnnotation(descriptor: String, visible: Boolean): AnnotationVisitor? {
            if (visible && descriptor == "Lkotlinx/serialization/Serializable;") {
              serializable.add(name)
            }
            return null
          }
        },
        ClassReader.SKIP_CODE or ClassReader.SKIP_DEBUG or ClassReader.SKIP_FRAMES,
      )
    }
    // Only @Serializable classes under these prefixes must survive unrenamed; the rest of an owned
    // dependency (an unused wire protocol, say) may be shrunk or obfuscated.
    val keptSerializable = serializable.filter { name ->
      keptSerializablePrefixes.any { name.replace('.', '/').startsWith(it) }
    }
    val serializers = keptSerializable.map { "$it\$\$serializer" }.filter { it in ownedClasses }
    val classes = mutableMapOf<String, String>()
    val methods = mutableMapOf<String, MutableSet<String>>()
    var owner: String? = null
    for (line in mappingText.lineSequence()) {
      if (line.isBlank() || line.trimStart().startsWith('#')) continue
      if (!line.first().isWhitespace()) {
        val match = CLASS_MAPPING.matchEntire(line)
        requireNotNull(match) { "Invalid R8 class mapping: $line" }
        owner = match.groupValues[1]
        classes[owner] = match.groupValues[2]
      } else {
        val match = METHOD_MAPPING.matchEntire(line.trim()) ?: continue
        val currentOwner = requireNotNull(owner) { "R8 member mapping without a class: $line" }
        methods
          .getOrPut("$currentOwner#${match.groupValues[1]}") { mutableSetOf() }
          .add(match.groupValues[2])
      }
    }
    val violations = mutableListOf<String>()
    if (components.isEmpty()) violations.add("manifest component: zero components found")
    if (keptSerializable.isEmpty()) violations.add("@Serializable class: zero classes found")
    fun checkClass(category: String, name: String) {
      val finalName = classes[name]
      if (finalName == null || finalName.startsWith("R8\$\$REMOVED\$\$CLASS\$\$")) {
        violations.add("$category $name: removed")
      } else if (finalName != name) violations.add("$category $name: renamed to $finalName")
    }
    components.forEach { checkClass("manifest component", it) }
    referencedClasses.forEach { checkClass("manifest-referenced class", it) }
    keptSerializable.forEach { checkClass("@Serializable class", it) }
    serializers.forEach { checkClass("serializer", it) }
    val sentinels = requiredMembers.distinct().sorted()
    for (sentinel in sentinels) {
      require(sentinel.count { it == '#' } == 1 && sentinel.substringAfter('#').isNotEmpty()) {
        "Invalid reflective member: $sentinel"
      }
      val className = sentinel.substringBefore('#')
      val methodName = sentinel.substringAfter('#')
      val finalClass = classes[className]
      val finalMethods = methods[sentinel].orEmpty()
      if (finalClass == null || finalClass.startsWith("R8\$\$REMOVED\$\$CLASS\$\$")) {
        violations.add("reflective member $sentinel: removed")
      } else {
        if (finalClass != className) {
          violations.add("reflective member $sentinel: renamed to $finalClass#$methodName")
        }
        if (finalMethods.isEmpty()) violations.add("reflective member $sentinel: removed")
        else if (methodName !in finalMethods) {
          violations.add(
            "reflective member $sentinel: renamed to ${finalMethods.sorted().joinToString()}",
          )
        }
      }
    }
    return Result(
      components,
      referencedClasses,
      keptSerializable,
      serializers,
      sentinels,
      violations.sorted(),
    )
  }

  private fun manifestClasses(xml: String, namespace: String): Pair<List<String>, List<String>> {
    val factory = DocumentBuilderFactory.newInstance()
    factory.isNamespaceAware = true
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
    factory.setFeature("http://xml.org/sax/features/external-general-entities", false)
    factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false)
    val document = factory.newDocumentBuilder().parse(InputSource(StringReader(xml)))
    val base = document.documentElement.getAttribute("package").ifBlank { namespace }
    require(base.isNotBlank()) { "Merged manifest has neither a package nor a namespace" }
    val names = sortedSetOf<String>()
    val referencedNames = sortedSetOf<String>()
    fun resolveName(name: String): String =
      when {
        name.startsWith('.') -> base + name
        '.' !in name -> "$base.$name"
        else -> name
      }
    for (tag in
      listOf("application", "activity", "activity-alias", "service", "receiver", "provider")) {
      val elements = document.getElementsByTagName(tag)
      for (index in 0 until elements.length) {
        val element = elements.item(index) as Element
        if (tag == "application") {
          val factoryName =
            element.getAttributeNS(
              "http://schemas.android.com/apk/res/android",
              "appComponentFactory",
            )
          if (factoryName.isNotBlank()) referencedNames.add(resolveName(factoryName))
        }
        // An alias is not a class; its targetActivity is the component that must survive.
        val attribute = if (tag == "activity-alias") "targetActivity" else "name"
        val name = element.getAttributeNS("http://schemas.android.com/apk/res/android", attribute)
        if (name.isBlank()) continue
        names.add(resolveName(name))
      }
    }
    val metadata = document.getElementsByTagName("meta-data")
    for (index in 0 until metadata.length) {
      val element = metadata.item(index) as Element
      if (
        element.getAttributeNS("http://schemas.android.com/apk/res/android", "value") !=
          "androidx.startup"
      ) {
        continue
      }
      val name = element.getAttributeNS("http://schemas.android.com/apk/res/android", "name")
      if (name.isNotBlank()) referencedNames.add(resolveName(name))
    }
    return names.toList() to referencedNames.toList()
  }

  private val CLASS_MAPPING = Regex("([^\\s]+) -> ([^\\s]+):")
  private val METHOD_MAPPING =
    Regex("(?:\\d+:\\d+:)?\\S+ ([^ (]+)\\([^)]*\\)(?::\\d+(?::\\d+)?)? -> (\\S+)")
}
