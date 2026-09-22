#!/usr/bin/env bash
#
# validate_lychee.sh
#
# Validates all links in documentation files using lychee link checker.
# Runs two passes:
#   1. Source pass: docs/, root *.md, and .github/CONTRIBUTING.md (which the
#      docs deploy copies to the site's Contributing page). Checks internal and
#      external links, including #fragments and links inside MkDocs content
#      tabs (see include_fragments / include_verbatim in .lycherc.toml).
#   2. Built-site pass: builds the MkDocs site into a temp dir and checks it
#      offline (local targets + fragments only; external URLs were already
#      checked in pass 1). This covers what only exists after the build:
#      directory-style URLs from the redirect shims, nav links, and heading
#      anchors as MkDocs slugifies them.
#
# The built-site pass needs MkDocs (via `uv run --project scripts/github`, or
# `mkdocs` on PATH). Without it the pass is skipped with a warning, unless
# LYCHEE_REQUIRE_SITE=true (CI), in which case a missing MkDocs is an error.
#
# Exit codes:
#   0 - All links are valid
#   1 - lychee not installed or configuration error
#   2 - Broken links found
#
# Usage:
#   ./scripts/lychee/validate_lychee.sh [--verbose] [--offline]
#
# Options:
#   --verbose    Show detailed output including excluded and unsupported links
#   --offline    Skip network requests in both passes (local files/anchors only)
#
set -euo pipefail

# Parse arguments
VERBOSE_FLAG=""
OFFLINE_FLAG=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose|-v)
            VERBOSE_FLAG="-vv"
            shift
            ;;
        --offline)
            OFFLINE_FLAG="--offline"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--verbose] [--offline]"
            exit 1
            ;;
    esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LYCHEE_CONFIG="$PROJECT_ROOT/.lycherc.toml"

print_status "Validating documentation links with lychee..."

# Check if lychee is installed
if ! command -v lychee >/dev/null 2>&1; then
    print_error "lychee is not installed"
    echo ""
    echo "To install lychee, run:"
    echo "  ./scripts/lychee/install_lychee.sh"
    echo ""
    echo "Or install manually:"
    echo "  - macOS:   brew install lychee"
    echo "  - Linux:   cargo install lychee"
    echo "  - Other:   See https://github.com/lycheeverse/lychee"
    exit 1
fi

# Show lychee version
LYCHEE_VERSION=$(lychee --version | head -1)
print_status "Using $LYCHEE_VERSION"

# Lychee routes github.com links through the GitHub API (not throttled HTTP
# scraping) when GITHUB_TOKEN is set. Without it, the many self-referencing
# issue/actions links in our docs mass-timeout under GitHub's unauthenticated
# rate limit. CI injects the token via env; for local runs, fall back to the
# developer's gh CLI credentials so behavior matches CI.
if [[ -z "${GITHUB_TOKEN:-}" ]] && command -v gh >/dev/null 2>&1; then
    # Pin to github.com so a set GH_HOST (e.g. GitHub Enterprise) can't leak an
    # Enterprise token into GITHUB_TOKEN for github.com link checks.
    if GH_TOKEN=$(gh auth token --hostname github.com 2>/dev/null) && [[ -n "$GH_TOKEN" ]]; then
        export GITHUB_TOKEN="$GH_TOKEN"
        print_status "Using GitHub token from gh CLI for github.com link checks"
    fi
fi

if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    print_status "GITHUB_TOKEN present: github.com links checked via GitHub API"
else
    print_warning "No GITHUB_TOKEN: github.com links may time out under rate limits"
fi

# The config carries the excludes, fragment/verbatim settings, and retry policy
# this check depends on; running without it would validate something else.
if [[ ! -f "$LYCHEE_CONFIG" ]]; then
    print_error "Lychee config not found at: $LYCHEE_CONFIG"
    exit 1
fi

cd "$PROJECT_ROOT"

# Function to suggest similar files for broken file:// links
suggest_similar_files() {
    local broken_path="$1"
    local basename_file
    basename_file=$(basename "$broken_path")

    local found_suggestions=false

    # First, check git history for renamed/moved files
    if git rev-parse --git-dir > /dev/null 2>&1; then
        # Look for files that were moved or renamed
        local git_suggestions
        git_suggestions=$(git log --follow --all --diff-filter=R --find-renames --name-status --pretty="" -- "*${basename_file}" 2>/dev/null | \
            grep -E "^R" | \
            awk '{print $3}' | \
            head -3)

        if [[ -n "$git_suggestions" ]]; then
            echo "      File was moved (from git history):"
            echo "$git_suggestions" | while IFS= read -r match; do
                if [[ -f "$match" ]]; then
                    echo "        - $match"
                    found_suggestions=true
                fi
            done
        fi
    fi

    # Search for files with similar names in current tree (docs/ and root *.md)
    local suggestions
    suggestions=$(find docs/ -type f -name "*${basename_file}*" 2>/dev/null | head -5)
    local root_suggestions
    root_suggestions=$(find . -maxdepth 1 -type f -name "*${basename_file}*" 2>/dev/null | head -3)
    suggestions="${suggestions}${root_suggestions:+$'\n'$root_suggestions}"

    if [[ -n "$suggestions" ]]; then
        if [[ "$found_suggestions" == false ]]; then
            echo "      Possible matches:"
        else
            echo "      Other possible matches:"
        fi
        echo "$suggestions" | while IFS= read -r match; do
            echo "        - $match"
        done
        found_suggestions=true
    fi

    # If still no suggestions, check if file was deleted
    if [[ "$found_suggestions" == false ]] && git rev-parse --git-dir > /dev/null 2>&1; then
        local deleted_info
        deleted_info=$(git log --all --diff-filter=D --summary -- "*${basename_file}" 2>/dev/null | grep "delete mode" | head -1)

        if [[ -n "$deleted_info" ]]; then
            echo "      File was deleted in git history (no current replacement found)"
        fi
    fi
}

LYCHEE_OUTPUT=$(mktemp)
LYCHEE_ERRORS=$(mktemp)
SITE_STAGE=$(mktemp -d)
trap 'rm -rf "$LYCHEE_OUTPUT" "$LYCHEE_ERRORS" "$SITE_STAGE"' EXIT

OVERALL_STATUS=0
record_status() {
    local status="$1"
    if [[ "$status" -eq 0 ]]; then
        return
    fi
    # A lychee/config failure (not 2) outranks broken links.
    if [[ "$status" -ne 2 ]] || [[ "$OVERALL_STATUS" -eq 0 ]]; then
        OVERALL_STATUS="$status"
    fi
}

# Runs one lychee pass, appending its output to $LYCHEE_OUTPUT, and records
# lychee's exit code (0 ok, 2 broken links, other = lychee/config failure) via
# record_status. Always returns 0 so callers invoke it plainly and set -e stays
# armed inside it.
run_lychee_pass() {
    local status=0
    # --include-fragments verifies #anchors, not just that the target exists (a
    # renamed heading otherwise passes silently). It is a CLI flag, not a config
    # key, because the key's type changed between lychee 0.22 and 0.24.
    # shellcheck disable=SC2086 # VERBOSE_FLAG/OFFLINE_FLAG are intentionally unquoted (empty or one flag)
    lychee --config "$LYCHEE_CONFIG" --no-progress --include-fragments $VERBOSE_FLAG $OFFLINE_FLAG "$@" 2>&1 | tee -a "$LYCHEE_OUTPUT" || status=${PIPESTATUS[0]}
    record_status "$status"
}

# Builds the MkDocs site into $SITE_STAGE/built from a staged copy of docs/, so
# the working tree is never mutated. Mirrors the deploy by staging
# .github/CONTRIBUTING.md as docs/contributing.md (the nav's Contributing page).
# Sets BUILD_STATUS: 0 on success, 3 when MkDocs is unavailable, 1 when the
# build fails. Always returns 0 so set -e stays armed for the staging copies.
BUILD_STATUS=0
build_site() {
    cp -R "$PROJECT_ROOT/docs" "$SITE_STAGE/docs"
    cp "$PROJECT_ROOT/mkdocs.yml" "$SITE_STAGE/mkdocs.yml"
    cp "$PROJECT_ROOT/.github/CONTRIBUTING.md" "$SITE_STAGE/docs/contributing.md"

    local -a mkdocs_cmd
    if command -v uv >/dev/null 2>&1 && [[ -f "$PROJECT_ROOT/scripts/github/uv.lock" ]]; then
        mkdocs_cmd=(uv run --project "$PROJECT_ROOT/scripts/github" --locked mkdocs)
    elif command -v mkdocs >/dev/null 2>&1; then
        mkdocs_cmd=(mkdocs)
    else
        BUILD_STATUS=3
        return 0
    fi

    "${mkdocs_cmd[@]}" build --quiet --config-file "$SITE_STAGE/mkdocs.yml" --site-dir "$SITE_STAGE/built" || BUILD_STATUS=1
}

print_status "Pass 1/2: source files (docs/, root *.md, .github/CONTRIBUTING.md)"
run_lychee_pass "docs/" ./*.md ".github/CONTRIBUTING.md"

echo ""
print_status "Pass 2/2: built MkDocs site (offline: local targets and anchors)"
build_site
if [[ "$BUILD_STATUS" -eq 0 ]]; then
    # External URLs were checked in pass 1; this pass only resolves the site's
    # own pages, assets, directory URLs (via index.html), and #fragments.
    OFFLINE_FLAG="--offline" run_lychee_pass \
        --index-files index.html \
        --extensions html \
        --root-dir "$SITE_STAGE/built" \
        "$SITE_STAGE/built"
elif [[ "$BUILD_STATUS" -eq 3 ]]; then
    if [[ "${LYCHEE_REQUIRE_SITE:-false}" == "true" ]]; then
        print_error "MkDocs is not available (need uv or mkdocs) and LYCHEE_REQUIRE_SITE=true"
        exit 1
    fi
    print_warning "Skipping built-site pass: MkDocs not available (install uv to use scripts/github/uv.lock, or put mkdocs on PATH)"
else
    print_error "MkDocs build failed; cannot check the built site"
    exit 1
fi

if [[ "$OVERALL_STATUS" -eq 0 ]]; then
    print_status "✓ All links are valid"
    exit 0
fi

if [[ "$OVERALL_STATUS" -ne 2 ]]; then
    print_error "✗ Lychee failed with exit code $OVERALL_STATUS"
    exit 1
fi

# Extract broken file:// links and provide suggestions
grep -E "\[ERROR\].*file://" "$LYCHEE_OUTPUT" | grep "Cannot find file" > "$LYCHEE_ERRORS" || true

if [[ -s "$LYCHEE_ERRORS" ]]; then
    echo ""
    print_warning "Suggestions for broken file:// links:"
    echo ""
    while IFS= read -r error_line; do
        # Extract the file path from the error
        if [[ "$error_line" =~ file://([^[:space:]|]+) ]]; then
            broken_path="${BASH_REMATCH[1]}"
            echo "  ✗ $broken_path"
            suggest_similar_files "$broken_path"
            echo ""
        fi
    done < "$LYCHEE_ERRORS"
fi

print_error "✗ Broken links found"
echo ""
echo "To fix broken links:"
echo "  1. Update the links to point to valid URLs (or existing #anchors)"
echo "  2. Remove dead links from documentation"
echo "  3. Add exclusions to .lycherc.toml if links are intentionally unreachable"
exit 2
