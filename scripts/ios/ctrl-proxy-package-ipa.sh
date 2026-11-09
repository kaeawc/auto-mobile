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
OUTPUT_PATH="$(cd "$(dirname "$OUTPUT_PATH")" && pwd)/$(basename "$OUTPUT_PATH")"

STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT
mkdir -p "${STAGING_DIR}/Build"
cp -pR "${PRODUCTS_PARENT}/Products" "${STAGING_DIR}/Build/Products"

if [[ "$FULL_DEBUG" != 1 ]]; then
    shopt -s nullglob dotglob
    # Only immediate entries of each configuration are build-time artifacts.
    # Never descend into app, test, framework, or package bundles to filter.
    for configuration in "${STAGING_DIR}/Build/Products"/*; do
        [[ -d "$configuration" && ! -L "$configuration" ]] || continue
        for module in "$configuration"/*.swiftmodule; do
            if [[ -d "$module" ]]; then
                rm -rf "$module"
            fi
        done
        for object in "$configuration"/*.o; do
            if [[ -f "$object" ]]; then
                rm -f "$object"
            fi
        done
    done
fi

# ZIP updates retain stale entries, so always create a fresh archive.
rm -f "$OUTPUT_PATH"
cd "$STAGING_DIR"
zip -qr "$OUTPUT_PATH" Build/Products/
