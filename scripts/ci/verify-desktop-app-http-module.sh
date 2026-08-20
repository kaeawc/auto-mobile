#!/usr/bin/env bash
#
# Verify that a packaged AutoMobile desktop app includes the JDK HTTP client
# module required by the startup update checker.
#
# Usage: verify-desktop-app-http-module.sh <AutoMobile.app>
# Env:   JIMAGE (optional) — override the jimage binary for tests.
set -euo pipefail

app_path="${1:-}"
if [ -z "${app_path}" ]; then
  echo "usage: verify-desktop-app-http-module.sh <AutoMobile.app>" >&2
  exit 2
fi
if [ ! -d "${app_path}" ]; then
  echo "verify-desktop-app-http-module: app not found: ${app_path}" >&2
  exit 2
fi

module_image="${app_path}/Contents/runtime/Contents/Home/lib/modules"
if [ ! -f "${module_image}" ]; then
  echo "verify-desktop-app-http-module: Java module image not found: ${module_image}" >&2
  exit 2
fi

jimage_bin="${JIMAGE:-${JAVA_HOME:+${JAVA_HOME}/bin/jimage}}"
if [ -z "${jimage_bin}" ]; then
  echo "verify-desktop-app-http-module: set JAVA_HOME or JIMAGE" >&2
  exit 2
fi

# Do not use grep -q here: with pipefail it can close the pipe early, causing
# jimage to receive SIGPIPE and turning a valid runtime image into a false failure.
if ! "${jimage_bin}" list "${module_image}" | grep 'java/net/http/HttpClient.class$' >/dev/null; then
  echo "Packaged Java runtime is missing java.net.http (HttpClient)" >&2
  exit 1
fi

echo "Verified java.net.http in ${app_path}"
