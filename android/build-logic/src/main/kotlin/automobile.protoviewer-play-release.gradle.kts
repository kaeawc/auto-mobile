import com.android.build.api.artifact.SingleArtifact
import com.android.build.api.dsl.ApplicationExtension
import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import dev.jasonpearson.automobile.buildlogic.protoviewer.ProtoViewerInputNames
import dev.jasonpearson.automobile.buildlogic.protoviewer.ProtoViewerReleaseConfig
import dev.jasonpearson.automobile.buildlogic.protoviewer.ProtoViewerReleaseInputs
import dev.jasonpearson.automobile.buildlogic.protoviewer.VerifyProtoViewerAabTask
import dev.jasonpearson.automobile.buildlogic.protoviewer.VerifyProtoViewerReleaseInputsTask
import java.io.File
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.getByType

// Play-ready release convention for the standalone ProtoViewer app (#14146): a dedicated,
// fail-closed signing config, a versionCode derived from the release version, an AAB verifier and a
// per-versionCode R8 mapping archive. It replaces automobile.android-app-signing for ProtoViewer,
// which falls back open and signs debug builds with the release key. Inputs come from the
// environment (CI) or gradle.properties (local); names live in ProtoViewerInputNames and are
// documented in docs/design-docs/protoviewer.md. Debug builds always use the debug key.

fun input(name: String): String? =
  providers.environmentVariable(name).orElse(providers.gradleProperty(name)).orNull

val plan =
  ProtoViewerReleaseConfig.plan(
    ProtoViewerReleaseInputs(
      requireRelease =
        input(ProtoViewerInputNames.REQUIRE_RELEASE)?.equals("true", ignoreCase = true) == true,
      releaseVersion = input(ProtoViewerInputNames.RELEASE_VERSION),
      keystorePath = input(ProtoViewerInputNames.KEYSTORE_PATH),
      keystorePassword = input(ProtoViewerInputNames.KEYSTORE_PASSWORD),
      keyAlias = input(ProtoViewerInputNames.KEY_ALIAS),
      keyPassword = input(ProtoViewerInputNames.KEY_PASSWORD),
    ),
    keystoreExists = { path ->
      File(path).let { if (it.isAbsolute) it else rootDir.resolve(path) }.exists()
    },
  )
val requireRelease =
  input(ProtoViewerInputNames.REQUIRE_RELEASE)?.equals("true", ignoreCase = true) == true

pluginManager.withPlugin("com.android.application") {
  extensions.configure<ApplicationExtension> {
    signingConfigs {
      create("protoviewerRelease") {
        input(ProtoViewerInputNames.KEYSTORE_PATH)
          ?.takeIf { it.isNotBlank() }
          ?.let { path ->
            storeFile = File(path).let { if (it.isAbsolute) it else rootDir.resolve(path) }
          }
        storePassword = input(ProtoViewerInputNames.KEYSTORE_PASSWORD)
        keyAlias = input(ProtoViewerInputNames.KEY_ALIAS)
        keyPassword = input(ProtoViewerInputNames.KEY_PASSWORD)
      }
    }
    buildTypes {
      getByName("release") {
        signingConfig =
          signingConfigs.getByName(if (plan.useReleaseKey) "protoviewerRelease" else "debug")
      }
      getByName("debug") { signingConfig = signingConfigs.getByName("debug") }
    }
  }

  val verifyInputs =
    tasks.register<VerifyProtoViewerReleaseInputsTask>("verifyProtoViewerReleaseInputs") {
      group = "verification"
      description =
        "Fails a required ProtoViewer release build with missing signing or version inputs."
      errors.set(plan.errors)
      outputs.upToDateWhen { false }
    }
  tasks.configureEach { if (name == "preReleaseBuild") dependsOn(verifyInputs) }

  val components = extensions.getByType<ApplicationAndroidComponentsExtension>()
  components.onVariants(components.selector().withBuildType("release")) { variant ->
    plan.versionName?.let { name -> variant.outputs.forEach { it.versionName.set(name) } }
    variant.outputs.forEach { it.versionCode.set(plan.versionCode) }

    val archiveDir = layout.buildDirectory.dir("outputs/release-archive")
    val verifyAab =
      tasks.register<VerifyProtoViewerAabTask>("verifyProtoViewerReleaseAab") {
        group = "verification"
        description = "Checks the release AAB is complete, signed and carries an R8 mapping."
        bundleFile.set(variant.artifacts.get(SingleArtifact.BUNDLE))
        requireReleaseSignature.set(requireRelease)
        requireMapping.set(variant.isMinifyEnabled)
        reportFile.set(layout.buildDirectory.file("reports/protoviewer/release-aab.txt"))
      }
    // Keep the de-obfuscation map keyed by versionCode so any released build's stack traces can be
    // read later; Play also receives the same map inside the AAB.
    val mappingName = "mapping-${plan.versionCode}.txt"
    val archiveMapping =
      if (variant.isMinifyEnabled) {
        tasks.register<Copy>("archiveProtoViewerReleaseMapping") {
          group = "distribution"
          description =
            "Copies mapping.txt to build/outputs/release-archive/mapping-<versionCode>.txt."
          from(variant.artifacts.get(SingleArtifact.OBFUSCATION_MAPPING_FILE))
          into(archiveDir)
          rename { mappingName }
        }
      } else {
        null
      }
    tasks
      .matching { it.name == "bundleRelease" }
      .configureEach {
        finalizedBy(verifyAab)
        archiveMapping?.let { finalizedBy(it) }
      }
  }
}
