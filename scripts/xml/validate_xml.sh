#!/usr/bin/env bash

# Checks every tracked XML file is well-formed.
#
# The check is well-formedness only (`xmlstarlet val -w`), so it does not need
# xmlstarlet: when neither `xml` (Homebrew's xmlstarlet name) nor `xmlstarlet`
# is installed, it uses python3's bundled expat parser, which ubuntu-latest
# ships. CI relies on that backend so an Ubuntu apt mirror outage cannot block
# the required XML checks (#17930). XML_VALIDATOR_BACKEND (xml, xmlstarlet or
# python3) forces a backend.

select_backend() {
  if [[ -n "${XML_VALIDATOR_BACKEND:-}" ]]; then
    echo "$XML_VALIDATOR_BACKEND"
  elif [[ "$OSTYPE" == "darwin"* ]] && command -v xml &>/dev/null; then
    echo xml
  elif command -v xmlstarlet &>/dev/null; then
    echo xmlstarlet
  elif command -v xml &>/dev/null; then
    echo xml
  elif command -v python3 &>/dev/null; then
    echo python3
  fi
}

XML_VALIDATOR_BACKEND="$(select_backend)"
export XML_VALIDATOR_BACKEND

# Check for a usable XML tool. Test the exit status directly: capturing
# `$(! command -v xml &>/dev/null)` yields stdout (always empty), never a status.
if [[ -z "$XML_VALIDATOR_BACKEND" ]] || ! command -v "$XML_VALIDATOR_BACKEND" &>/dev/null; then
  echo "xmlstarlet missing, please install (or provide python3)."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Try 'brew install xmlstarlet'"
  else
    echo "Consult your OS package manager"
  fi
  exit 1
fi

# Validate one file with the selected backend; errors go to stderr.
validate_xml_file() {
  case "$XML_VALIDATOR_BACKEND" in
    python3)
      python3 - "$1" << 'PY'
import sys
import xml.parsers.expat

path = sys.argv[1]
parser = xml.parsers.expat.ParserCreate()
try:
    with open(path, "rb") as handle:
        parser.ParseFile(handle)
except xml.parsers.expat.ExpatError as error:
    print(f"{path}:{error.lineno}.{error.offset}: {xml.parsers.expat.ErrorString(error.code)}", file=sys.stderr)
    sys.exit(1)
except OSError as error:
    print(f"{path}: {error}", file=sys.stderr)
    sys.exit(1)
PY
      ;;
    *) "$XML_VALIDATOR_BACKEND" val -w -b -e "$1" ;;
  esac
}

# Start the timer
start_time=$(bash -c "$(pwd)/scripts/utils/get_timestamp.sh")

# shellcheck source=scripts/lib/vcs-diff.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/vcs-diff.sh"

# Need to export this function for xargs bash to see it
export -f validate_xml_file

# Portable CPU count: nproc (GNU) is absent on stock macOS, where an empty
# `$(nproc)` made `xargs -P ""` fail. Fall back to sysctl/getconf (#3653).
NPROC="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

# Find XML files, excluding ignored files.
errors=$(vcs_list_files @ |
  grep -z '\.xml$' |
  xargs -0 -n 1 -P "$NPROC" bash -c "validate_xml_file \"\$0\"" 2>&1)

# Calculate total elapsed time
end_time=$(bash -c "$(pwd)/scripts/utils/get_timestamp.sh")
total_elapsed=$((end_time - start_time))

# Check and report errors
if [[ -n $errors ]]; then
  echo "Errors in the following files:"
  echo "$errors"
  echo "Total time elapsed in $total_elapsed ms."
  exit 1
else
  echo "No XML errors found in $total_elapsed ms (${XML_VALIDATOR_BACKEND})."
fi
