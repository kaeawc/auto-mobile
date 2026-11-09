#!/bin/bash
# Package existing CtrlProxy products without building or modifying them.
# --products is the Build directory containing Products/.
# --full-debug or CTRL_PROXY_IPA_FULL_DEBUG=1 retains build-time debug inputs.
set -euo pipefail

usage() {
    echo "Usage: $0 --products <Build directory> --output <zip> [--full-debug]" >&2
}

PRODUCTS_PARENT=""
OUTPUT_PATH=""
FULL_DEBUG="${CTRL_PROXY_IPA_FULL_DEBUG:-0}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --products|--output)
            if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
                usage
                exit 1
            fi
            if [[ "$1" == --products ]]; then
                PRODUCTS_PARENT="$2"
            else
                OUTPUT_PATH="$2"
            fi
            shift 2
            ;;
        --full-debug)
            FULL_DEBUG=1
            shift
            ;;
        *)
            usage
            exit 1
            ;;
    esac
done

if [[ -z "$PRODUCTS_PARENT" || -z "$OUTPUT_PATH" ]]; then
    usage
    exit 1
fi
if [[ ! -d "${PRODUCTS_PARENT}/Products" ]]; then
    echo "Products directory not found: ${PRODUCTS_PARENT}/Products" >&2
    exit 1
fi

PRODUCTS_PARENT="$(cd "$PRODUCTS_PARENT" && pwd)"
mkdir -p "$(dirname "$OUTPUT_PATH")"
OUTPUT_DIR="$(cd "$(dirname "$OUTPUT_PATH")" && pwd)"
OUTPUT_PATH="${OUTPUT_DIR}/$(basename "$OUTPUT_PATH")"

# Resolve a symlinked Products root (relative or absolute) to its real
# directory so staging holds a real copy, never a link back into the build.
PRODUCTS_SOURCE="$(cd "${PRODUCTS_PARENT}/Products" && pwd -P)"

STAGING_DIR="$(mktemp -d)"
TEMP_ARCHIVE=""
trap 'if [[ -n "$TEMP_ARCHIVE" ]]; then rm -f -- "$TEMP_ARCHIVE"; fi; rm -rf "$STAGING_DIR"' EXIT
STAGING_DIR="$(cd "$STAGING_DIR" && pwd -P)"
STAGED_PRODUCTS="${STAGING_DIR}/Build/Products"
mkdir -p "$STAGED_PRODUCTS"
cp -pR "${PRODUCTS_SOURCE}/." "$STAGED_PRODUCTS/"

# Refuse to delete anything whose real location is outside the staging copy.
prune_staged() {
    local target="$1" real_parent
    real_parent="$(cd "$(dirname "$target")" && pwd -P)"
    if [[ -L "$target" || "${real_parent}/" != "${STAGED_PRODUCTS}/"* ]]; then
        echo "Refusing to prune path outside staging: ${target}" >&2
        exit 1
    fi
    rm -rf -- "${real_parent:?}/$(basename "$target")"
}

if [[ "$FULL_DEBUG" != 1 ]]; then
    shopt -s nullglob dotglob
    # Only immediate entries of each configuration are build-time artifacts.
    # Never descend into app, test, framework, or package bundles to filter.
    for configuration in "$STAGED_PRODUCTS"/*; do
        [[ -d "$configuration" && ! -L "$configuration" ]] || continue
        for module in "$configuration"/*.swiftmodule; do
            if [[ -d "$module" && ! -L "$module" ]]; then
                prune_staged "$module"
            fi
        done
        for object in "$configuration"/*.o; do
            if [[ -f "$object" && ! -L "$object" ]]; then
                prune_staged "$object"
            fi
        done
    done
fi

# Check after pruning: a link that resolved in the source may now be dangling.
# Keep find outside process substitution so a scan failure also stops packaging.
find "$STAGED_PRODUCTS" -type l ! -exec test -e {} \; -print0 > "${STAGING_DIR}/dangling-links"
DANGLING_LINKS=0
while IFS= read -r -d '' link; do
    printf 'Dangling symlink in staged Products: %s -> %s\n' \
        "${link#"${STAGED_PRODUCTS}/"}" "$(readlink "$link")" >&2
    DANGLING_LINKS=1
done < "${STAGING_DIR}/dangling-links"
if [[ "$DANGLING_LINKS" == 1 ]]; then
    exit 1
fi

# ZIP updates retain stale entries. Let zip create a fresh archive beside the
# output, then replace the output only after the complete archive is ready.
TEMP_ARCHIVE="$(mktemp "${OUTPUT_DIR}/.$(basename "$OUTPUT_PATH").XXXXXX")"
rm -f -- "$TEMP_ARCHIVE"
cd "$STAGING_DIR"
if zip -qr "$TEMP_ARCHIVE" Build/Products/; then
    mv -f -- "$TEMP_ARCHIVE" "$OUTPUT_PATH"
else
    zip_status=$?
    echo "Failed to create IPA archive: zip exited with status ${zip_status}" >&2
    exit "$zip_status"
fi
