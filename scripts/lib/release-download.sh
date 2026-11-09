#!/usr/bin/env bash
#
# Fetch a pinned release asset (ktfmt JAR, shfmt binary, ...) with a checksum-
# verified local cache and a bounded, jittered download backoff (#17624).
#
# GitHub release downloads can return 5xx for tens of minutes. curl's own
# `--retry 3` gives up within seconds, so an outage failed every CI run as if
# the code were wrong. Each fetch here:
#   1. reuses a cached copy when its SHA-256 still matches the pin (a mismatch
#      discards the entry and downloads again);
#   2. otherwise downloads with up to RELEASE_DOWNLOAD_ATTEMPTS tries and
#      exponential backoff plus jitter (about 60-90 s in total by default);
#   3. verifies the SHA-256 of the download before installing or caching it.
# When every attempt fails it prints one `UPSTREAM-DOWNLOAD-FAILURE:` line so a
# reader (and scripts/ci/known-flakes.txt) can tell an upstream outage from a
# code regression.
#
# Source it:
#   # shellcheck source=scripts/lib/release-download.sh
#   source "$(dirname "${BASH_SOURCE[0]}")/../lib/release-download.sh"
#
# Environment:
#   AUTOMOBILE_TOOL_CACHE_DIR            cache root (default
#                                        ${XDG_CACHE_HOME:-$HOME/.cache}/auto-mobile/tools);
#                                        CI restores this path with actions/cache
#   RELEASE_DOWNLOAD_ATTEMPTS            total download attempts (default 6)
#   RELEASE_DOWNLOAD_BASE_DELAY_SECONDS  first backoff delay (default 3)
#   RELEASE_DOWNLOAD_MAX_DELAY_SECONDS   per-wait delay cap (default 24)
#   RELEASE_DOWNLOAD_JITTER              "false" disables jitter (tests)

UPSTREAM_DOWNLOAD_FAILURE_MARKER="UPSTREAM-DOWNLOAD-FAILURE:"

release_download_cache_root() {
  printf '%s\n' "${AUTOMOBILE_TOOL_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/auto-mobile/tools}"
}

# sha256sum is GNU coreutils and absent on stock macOS; fall back to shasum.
release_sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# release_verify_sha256 <file> <expected-sha256>; prints the mismatch on failure.
release_verify_sha256() {
  local file="$1" expected="$2" actual
  actual="$(release_sha256_of "$file")"
  if [[ "$actual" == "$expected" ]]; then
    return 0
  fi
  echo "Checksum mismatch for ${file}: expected ${expected}, got ${actual:-none}" >&2
  return 1
}

# Delay before retry number <n> (1-based): base * 2^(n-1), capped, plus up to a
# quarter of that again as jitter so parallel runners do not retry in lockstep.
release_backoff_delay() {
  local n="$1"
  local base="${RELEASE_DOWNLOAD_BASE_DELAY_SECONDS:-3}"
  local cap="${RELEASE_DOWNLOAD_MAX_DELAY_SECONDS:-24}"
  local delay="$base" i
  for ((i = 1; i < n; i++)); do
    delay=$((delay * 2))
    if ((delay >= cap)); then
      break
    fi
  done
  if ((delay > cap)); then
    delay="$cap"
  fi
  if [[ "${RELEASE_DOWNLOAD_JITTER:-true}" != "false" ]]; then
    delay=$((delay + RANDOM % (delay / 4 + 1)))
  fi
  printf '%s\n' "$delay"
}

# release_download_with_backoff <url> <output-file>
# Returns 0 once a download succeeds; on final failure removes the partial file,
# prints the UPSTREAM-DOWNLOAD-FAILURE line and returns 1.
release_download_with_backoff() {
  local url="$1" out="$2"
  local attempts="${RELEASE_DOWNLOAD_ATTEMPTS:-6}"
  local attempt=1 err_file last_error="" delay rc

  if ! command -v curl > /dev/null 2>&1 && ! command -v wget > /dev/null 2>&1; then
    echo "Neither curl nor wget found. Install one, or download manually from: ${url}" >&2
    return 1
  fi

  err_file="$(mktemp "${TMPDIR:-/tmp}/release-download-err.XXXXXX")"
  while true; do
    echo "Downloading ${url} (attempt ${attempt}/${attempts})" >&2
    rc=0
    if command -v curl > /dev/null 2>&1; then
      # -f: an HTTP error exits 22 instead of saving an error page as the asset.
      curl -fsSL --connect-timeout 15 --max-time 600 -o "$out" "$url" 2> "$err_file" || rc=$?
    else
      wget -q -T 60 -O "$out" "$url" 2> "$err_file" || rc=$?
    fi
    if ((rc == 0)); then
      rm -f "$err_file"
      return 0
    fi
    cat "$err_file" >&2
    last_error="$(tail -n 1 "$err_file")"
    rm -f "$out"
    # A 4xx other than 408/429 means a wrong URL or pin, not an outage; retrying
    # cannot help, so fail now without the upstream-failure marker.
    if [[ "$last_error" =~ returned\ error:\ (4[0-9][0-9]) && "${BASH_REMATCH[1]}" != 408 && "${BASH_REMATCH[1]}" != 429 ]]; then
      rm -f "$err_file"
      echo "Download of ${url} failed with HTTP ${BASH_REMATCH[1]}; not retrying. Check the pinned version and asset name." >&2
      return 1
    fi
    if ((attempt >= attempts)); then
      break
    fi
    delay="$(release_backoff_delay "$attempt")"
    echo "Download failed (exit ${rc}); retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
  rm -f "$err_file"
  echo "${UPSTREAM_DOWNLOAD_FAILURE_MARKER} ${url} failed after ${attempts} attempts (last error: ${last_error:-exit ${rc}}). This is an upstream download failure, not a code change; rerun once the host recovers." >&2
  return 1
}

# release_fetch_pinned <url> <expected-sha256> <dest-file> <cache-namespace>
# Installs the asset at <dest-file>, from the cache when its checksum matches,
# else by download. The cache entry is <root>/<namespace>/<sha256>/<asset-name>,
# so a pin bump never reuses a stale file.
release_fetch_pinned() {
  local url="$1" sha="$2" dest="$3" namespace="$4"
  local cache_dir cache_file tmp
  cache_dir="$(release_download_cache_root)/${namespace}/${sha}"
  cache_file="${cache_dir}/${url##*/}"

  mkdir -p "$(dirname "$dest")" || return 1
  tmp="$(mktemp "${dest}.partial.XXXXXX")" || return 1

  if [[ -f "$cache_file" ]]; then
    if release_verify_sha256 "$cache_file" "$sha" && cp "$cache_file" "$tmp" && release_verify_sha256 "$tmp" "$sha"; then
      mv -f "$tmp" "$dest"
      echo "Using cached ${url##*/} (sha256 ${sha}) from ${cache_dir}" >&2
      return 0
    fi
    echo "Discarding cached ${url##*/} at ${cache_file}; downloading again." >&2
    rm -f "$cache_file"
  fi

  if ! release_download_with_backoff "$url" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! release_verify_sha256 "$tmp" "$sha"; then
    echo "Refusing to install ${url##*/}: its checksum does not match the pin." >&2
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$dest"

  # Caching is an optimization; a read-only or full cache dir must not fail the install.
  if mkdir -p "$cache_dir" 2> /dev/null && cp "$dest" "${cache_file}.tmp.$$" 2> /dev/null \
    && mv -f "${cache_file}.tmp.$$" "$cache_file" 2> /dev/null; then
    echo "Cached ${url##*/} in ${cache_dir}" >&2
  else
    rm -f "${cache_file}.tmp.$$"
    echo "Could not write the tool cache at ${cache_dir}; continuing without it." >&2
  fi
  return 0
}
