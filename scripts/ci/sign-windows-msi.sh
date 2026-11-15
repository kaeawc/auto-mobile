#!/usr/bin/env bash
#
# Authenticode-sign the Windows desktop .msi with Azure Trusted Signing via
# jsign (#4725). Runs on the windows-latest leg of
# build-desktop-app-installers.yml, after :desktop-app:packageMsi and before the
# installer is staged.
#
# Credentials are all-or-none:
#   - none set (forks, or before Trusted Signing onboarding): print a warning,
#     write `signed=false` to $GITHUB_OUTPUT and exit 0, leaving the MSI unsigned.
#   - some set: fail closed (exit 2) and name the missing ones, so a half-loaded
#     secret set cannot silently ship an unsigned installer.
#   - all set: fetch an Entra ID token (client-credentials grant), sign with
#     jsign --storetype TRUSTEDSIGNING, RFC 3161-timestamp it, and write
#     `signed=true` to $GITHUB_OUTPUT.
#
# Secrets never reach a command line: the client secret is posted from a 0600
# temp file and the access token is passed to jsign as `env:` indirection.
#
# Usage:  sign-windows-msi.sh <msi-path>
# Env:    AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
#         TRUSTED_SIGNING_ENDPOINT  e.g. https://eus.codesigning.azure.net
#         TRUSTED_SIGNING_ACCOUNT, TRUSTED_SIGNING_PROFILE
#         JSIGN_JAR (optional) — use this jar instead of downloading the pinned one.
#         CURL, JAVA, JQ (optional) — override the binaries, for tests.
set -euo pipefail

JSIGN_VERSION="7.6"
JSIGN_SHA256="6cf58aa080e7ff82656f320cff8d4a3bff30408df8766806dcba3740dd839fa5"
JSIGN_URL="https://repo1.maven.org/maven2/net/jsign/jsign/${JSIGN_VERSION}/jsign-${JSIGN_VERSION}.jar"
TIMESTAMP_URL="http://timestamp.acs.microsoft.com"

CURL="${CURL:-curl}"
JAVA="${JAVA:-java}"
JQ="${JQ:-jq}"

write_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "signed=$1" >>"${GITHUB_OUTPUT}"
  fi
}

msi="${1:-}"
if [ -z "${msi}" ]; then
  echo "usage: sign-windows-msi.sh <msi-path>" >&2
  exit 2
fi
if [ ! -f "${msi}" ]; then
  echo "sign-windows-msi: MSI not found: ${msi}" >&2
  exit 2
fi

required_vars=(
  AZURE_TENANT_ID
  AZURE_CLIENT_ID
  AZURE_CLIENT_SECRET
  TRUSTED_SIGNING_ENDPOINT
  TRUSTED_SIGNING_ACCOUNT
  TRUSTED_SIGNING_PROFILE
)
missing=()
for var in "${required_vars[@]}"; do
  if [ -z "${!var:-}" ]; then
    missing+=("${var}")
  fi
done

if [ "${#missing[@]}" -eq "${#required_vars[@]}" ]; then
  echo "::warning::Azure Trusted Signing secrets are not configured; ${msi} ships UNSIGNED (#4725)."
  write_output false
  exit 0
fi
if [ "${#missing[@]}" -gt 0 ]; then
  echo "sign-windows-msi: partial Azure Trusted Signing configuration; missing: ${missing[*]}" >&2
  exit 2
fi

# jsign's TRUSTEDSIGNING keystore is the bare endpoint host.
endpoint_host="${TRUSTED_SIGNING_ENDPOINT#https://}"
endpoint_host="${endpoint_host%/}"
if ! [[ "${endpoint_host}" =~ ^[a-z0-9-]+\.codesigning\.azure\.net$ ]]; then
  echo "sign-windows-msi: TRUSTED_SIGNING_ENDPOINT must be https://<region>.codesigning.azure.net, got: ${TRUSTED_SIGNING_ENDPOINT}" >&2
  exit 2
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

jar="${JSIGN_JAR:-}"
if [ -z "${jar}" ]; then
  jar="${work_dir}/jsign-${JSIGN_VERSION}.jar"
  "${CURL}" -sSfL --retry 3 -o "${jar}" "${JSIGN_URL}"
  actual_sha="$(sha256sum "${jar}" | cut -d' ' -f1)"
  if [ "${actual_sha}" != "${JSIGN_SHA256}" ]; then
    echo "sign-windows-msi: jsign ${JSIGN_VERSION} checksum mismatch (got ${actual_sha})" >&2
    exit 1
  fi
fi

secret_file="${work_dir}/client-secret"
(umask 077 && printf '%s' "${AZURE_CLIENT_SECRET}" >"${secret_file}")

token_json="$("${CURL}" -sSf --retry 3 \
  -X POST "https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=${AZURE_CLIENT_ID}" \
  --data-urlencode "client_secret@${secret_file}" \
  --data-urlencode "scope=https://codesigning.azure.net/.default")"

TRUSTED_SIGNING_TOKEN="$(printf '%s' "${token_json}" | "${JQ}" -r '.access_token // empty')"
if [ -z "${TRUSTED_SIGNING_TOKEN}" ]; then
  echo "sign-windows-msi: Entra ID token response carried no access_token" >&2
  exit 1
fi
echo "::add-mask::${TRUSTED_SIGNING_TOKEN}"
export TRUSTED_SIGNING_TOKEN

"${JAVA}" -jar "${jar}" \
  --storetype TRUSTEDSIGNING \
  --keystore "${endpoint_host}" \
  --storepass env:TRUSTED_SIGNING_TOKEN \
  --alias "${TRUSTED_SIGNING_ACCOUNT}/${TRUSTED_SIGNING_PROFILE}" \
  --tsaurl "${TIMESTAMP_URL}" \
  --tsmode RFC3161 \
  "${msi}"

echo "Signed ${msi} with Azure Trusted Signing profile ${TRUSTED_SIGNING_ACCOUNT}/${TRUSTED_SIGNING_PROFILE}"
write_output true
