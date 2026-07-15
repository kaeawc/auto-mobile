#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." && pwd)
ANDROID_DIR="${PROJECT_ROOT}/android"
SCRATCH_DIR="${PROJECT_ROOT}/scratch/junit-runner-kotlin-consumer"
CONSUMER_DIR="${SCRATCH_DIR}/consumer"
LOG_DIR="${SCRATCH_DIR}/logs"

KOTLIN_CONSUMER_VERSION="${KOTLIN_CONSUMER_VERSION:-2.2.21}"
KOTLIN_CONSUMER_STDLIB_VERSION=$(
  sed -n 's/^build-kotlin-consumer = "\([^"]*\)".*/\1/p' \
    "${ANDROID_DIR}/gradle/libs.versions.toml" | head -n 1
)
RUNNER_VERSION=$(
  sed -n 's/^VERSION_NAME=//p' "${ANDROID_DIR}/gradle.properties" | head -n 1
)
GROUP_ID=$(
  sed -n 's/^GROUP=//p' "${ANDROID_DIR}/gradle.properties" | head -n 1
)

if [[ -z "${RUNNER_VERSION}" || -z "${GROUP_ID}" ]]; then
  echo "Could not read GROUP and VERSION_NAME from android/gradle.properties" >&2
  exit 1
fi

if [[ -z "${KOTLIN_CONSUMER_STDLIB_VERSION}" ]]; then
  echo "Could not read build-kotlin-consumer from android/gradle/libs.versions.toml" >&2
  exit 1
fi

if [[ ! "${KOTLIN_CONSUMER_STDLIB_VERSION}" =~ ^2\.2\. ]]; then
  echo "Published runner/test-plan Kotlin stdlib consumer floor must remain on 2.2.x." >&2
  echo "Found build-kotlin-consumer=${KOTLIN_CONSUMER_STDLIB_VERSION} in android/gradle/libs.versions.toml." >&2
  exit 1
fi

rm -rf "${SCRATCH_DIR}"
mkdir -p "${CONSUMER_DIR}/src/test/kotlin/dev/jasonpearson/automobile/compat" "${LOG_DIR}"

(
  cd "${ANDROID_DIR}"
  ./gradlew \
    :test-plan-validation:publishToMavenLocal \
    :junit-runner:publishToMavenLocal \
    --stacktrace
) >"${LOG_DIR}/publish.log" 2>&1

cat >"${CONSUMER_DIR}/settings.gradle.kts" <<'GRADLE_SETTINGS'
pluginManagement {
  repositories {
    gradlePluginPortal()
    mavenCentral()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    mavenLocal()
    mavenCentral()
  }
}

rootProject.name = "junit-runner-kotlin-consumer"
GRADLE_SETTINGS

cat >"${CONSUMER_DIR}/build.gradle.kts" <<GRADLE_BUILD
plugins {
  kotlin("jvm") version "${KOTLIN_CONSUMER_VERSION}"
}

dependencies {
  testImplementation("${GROUP_ID}:auto-mobile-junit-runner:${RUNNER_VERSION}")
  testImplementation(kotlin("test"))
}

tasks.test {
  useJUnitPlatform()
}
GRADLE_BUILD

cat >"${CONSUMER_DIR}/src/test/kotlin/dev/jasonpearson/automobile/compat/RunnerConsumerCompatibilityTest.kt" <<'KOTLIN'
package dev.jasonpearson.automobile.compat

import dev.jasonpearson.automobile.junit.AutoMobileRunner
import dev.jasonpearson.automobile.validation.TestPlanValidator
import kotlin.test.Test
import kotlin.test.assertNotNull

class RunnerConsumerCompatibilityTest {
  @Test
  fun canReferenceRunnerAndValidationApis() {
    assertNotNull(AutoMobileRunner::class.qualifiedName)
    assertNotNull(TestPlanValidator.validateYaml("name: compat\nsteps: []\n"))
  }
}
KOTLIN

(
  cd "${ANDROID_DIR}"
  ./gradlew -p "${CONSUMER_DIR}" dependencyInsight \
    --dependency org.jetbrains.kotlin:kotlin-stdlib \
    --configuration testRuntimeClasspath \
    --stacktrace
) >"${LOG_DIR}/dependencyInsight.log" 2>&1

if grep -q 'org.jetbrains.kotlin:kotlin-stdlib:2\.4\.0' "${LOG_DIR}/dependencyInsight.log"; then
  echo "Kotlin ${KOTLIN_CONSUMER_VERSION} consumer resolved kotlin-stdlib 2.4.0 from auto-mobile-junit-runner." >&2
  echo "See ${LOG_DIR}/dependencyInsight.log" >&2
  exit 1
fi

(
  cd "${ANDROID_DIR}"
  ./gradlew -p "${CONSUMER_DIR}" test --stacktrace
) >"${LOG_DIR}/test.log" 2>&1

echo "Kotlin ${KOTLIN_CONSUMER_VERSION} consumer compiled and tested against auto-mobile-junit-runner ${RUNNER_VERSION}."
