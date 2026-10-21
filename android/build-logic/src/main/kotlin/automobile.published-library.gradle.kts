import com.vanniktech.maven.publish.MavenPublishBaseExtension
import org.gradle.kotlin.dsl.configure

// Shared Maven Central POM metadata for the published library modules. A module still
// applies the vanniktech publish plugin itself; this convention fills in coordinates and
// the POM from the module's own gradle.properties (POM_ARTIFACT_ID, POM_NAME,
// POM_DESCRIPTION) and the root's GROUP/POM_* values. The version comes from the
// automobile.kotlin-common convention, which sets it from VERSION_NAME.
pluginManager.apply("automobile.kotlin-common")

pluginManager.withPlugin("com.vanniktech.maven.publish") {
  extensions.configure<MavenPublishBaseExtension> {
    coordinates(
      property("GROUP").toString(),
      property("POM_ARTIFACT_ID").toString(),
      version.toString(),
    )

    pom {
      name.set(property("POM_NAME").toString())
      description.set(property("POM_DESCRIPTION").toString())
      inceptionYear.set("2025")
      url.set(property("POM_URL").toString())
      licenses {
        license {
          name.set(property("POM_LICENCE_NAME").toString())
          url.set(property("POM_LICENCE_URL").toString())
          distribution.set("repo")
        }
      }
      developers {
        developer {
          id.set(property("POM_DEVELOPER_ID").toString())
          name.set(property("POM_DEVELOPER_NAME").toString())
          url.set("https://github.com/${property("POM_DEVELOPER_ID")}/")
          email.set(property("POM_DEVELOPER_EMAIL").toString())
        }
      }
      scm {
        url.set(property("POM_SCM_URL").toString())
        connection.set(property("POM_SCM_CONNECTION").toString())
        developerConnection.set(property("POM_SCM_DEV_CONNECTION").toString())
      }
    }
  }
}
