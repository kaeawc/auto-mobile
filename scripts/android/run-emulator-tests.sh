#!/bin/bash
#
# Run emulator tests with APK installation
#
# This script:
# 1. Logs comprehensive debug information about the environment
# 2. Validates and installs the accessibility service APK
# 3. Runs the test script
#
# Usage:
#   ./scripts/android/run-emulator-tests.sh <apk-path> <test-script>
#
# Example:
#   ./scripts/android/run-emulator-tests.sh \
#     "accessibility-service/build/outputs/apk/debug/accessibility-service-debug.apk" \
#     "./gradlew :junit-runner:test"
#
# shellcheck disable=SC2012 # Using ls for readable debug output is appropriate here

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Arguments
APK_PATH="${1:-}"
TEST_SCRIPT="${2:-}"

# Validate arguments
if [ -z "$APK_PATH" ] || [ -z "$TEST_SCRIPT" ]; then
  echo -e "${RED}Error: Missing required arguments${NC}"
  echo "Usage: $0 <apk-path> <test-script>"
  echo "Example: $0 'accessibility-service/build/outputs/apk/debug/accessibility-service-debug.apk' './gradlew :junit-runner:test'"
  exit 1
fi

# Helper function for section headers
print_section() {
  local title="$1"
  echo ""
  echo -e "${BLUE}==========================================${NC}"
  echo -e "${BLUE}$title${NC}"
  echo -e "${BLUE}==========================================${NC}"
}

# Helper function for success messages
print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

# Helper function for error messages
print_error() {
  echo -e "${RED}✗ $1${NC}"
}

# Helper function for warning messages
print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

# Main script starts here
print_section "EMULATOR SETUP DEBUG START"

echo "Current shell: $SHELL"
echo "Current user: $(whoami)"
echo "Current directory: $(pwd)"
echo "APK path: $APK_PATH"
echo "Test script: $TEST_SCRIPT"
echo ""

print_section "ENVIRONMENT INFORMATION"

echo "Shell information:"
echo "  SHELL: $SHELL"
echo "  BASH_VERSION: ${BASH_VERSION:-unknown}"
echo ""

echo "User information:"
echo "  USER: $(whoami)"
echo "  HOME: ${HOME:-unknown}"
echo ""

echo "Android environment variables:"
env | grep -E "(ANDROID|ADB)" | sort || print_warning "No ANDROID/ADB variables found"
echo ""

echo "PATH:"
echo "  $PATH" | tr ':' '\n' | sed 's/^/  /'
echo ""

print_section "ADB AVAILABILITY CHECK"

if command -v adb &> /dev/null; then
  print_success "adb found in PATH"
  echo "adb location: $(which adb)"
  echo "adb version:"
  adb --version
else
  print_error "adb not found in PATH"
  exit 1
fi

echo ""

print_section "EMULATOR CONNECTIVITY CHECK"

if adb devices &> /dev/null; then
  print_success "adb devices command successful"
  echo "Connected devices:"
  adb devices | sed 's/^/  /'
else
  print_error "adb devices command failed"
  exit 1
fi

echo ""

print_section "ACCESSIBILITY APK INSTALLATION"

echo "Expected APK path: $APK_PATH"
echo "Current working directory: $(pwd)"
echo ""

if [ -z "$APK_PATH" ]; then
  print_warning "APK_PATH is empty, skipping APK installation"
else
  echo "Checking if APK file exists..."
  echo ""

  if [ ! -f "$APK_PATH" ]; then
    print_error "Accessibility APK not found at '$APK_PATH'"
    echo ""
    echo "Directory structure diagnostics:"
    echo ""

    echo "Current directory:"
    ls -la | head -20
    echo ""

    echo "accessibility-service/ directory:"
    if [ -d "accessibility-service" ]; then
      ls -la accessibility-service/ | head -20
    else
      print_warning "(directory not found)"
    fi
    echo ""

    echo "accessibility-service/build/ directory:"
    if [ -d "accessibility-service/build" ]; then
      ls -la accessibility-service/build/ | head -20
    else
      print_warning "(directory not found)"
    fi
    echo ""

    echo "accessibility-service/build/outputs/ directory:"
    if [ -d "accessibility-service/build/outputs" ]; then
      ls -la accessibility-service/build/outputs/ | head -20
    else
      print_warning "(directory not found)"
    fi
    echo ""

    echo "accessibility-service/build/outputs/apk/ directory:"
    if [ -d "accessibility-service/build/outputs/apk" ]; then
      ls -la accessibility-service/build/outputs/apk/ | head -20
    else
      print_warning "(directory not found)"
    fi
    echo ""

    echo "accessibility-service/build/outputs/apk/debug/ directory:"
    if [ -d "accessibility-service/build/outputs/apk/debug" ]; then
      ls -la accessibility-service/build/outputs/apk/debug/ | head -20
    else
      print_warning "(directory not found)"
    fi
    echo ""

    echo "Parent directory of APK: $(dirname "$APK_PATH")"
    if [ -d "$(dirname "$APK_PATH")" ]; then
      ls -la "$(dirname "$APK_PATH")" | head -20
    else
      print_warning "(directory not found)"
    fi
    echo ""

    print_error "Cannot proceed without APK file"
    exit 1
  fi

  print_success "APK file found at $APK_PATH"
  echo ""

  echo "APK file details:"
  ls -lh "$APK_PATH"
  file "$APK_PATH"
  echo ""

  echo "Installing accessibility service APK..."
  echo "Running: adb install -r '$APK_PATH'"
  echo ""

  if adb install -r "$APK_PATH"; then
    print_success "APK installed successfully"
  else
    APK_INSTALL_EXIT=$?
    print_error "APK installation failed with exit code $APK_INSTALL_EXIT"
    exit "$APK_INSTALL_EXIT"
  fi
fi

echo ""

print_section "DAEMON WARM-UP"

echo "Starting AutoMobile daemon to avoid first-test timeout..."
echo "This ensures the daemon is fully initialized before tests run."
echo ""

# Go to project root to access the built auto-mobile CLI
cd ..

# Build the TypeScript project if dist doesn't exist
if [ ! -f "dist/src/index.js" ]; then
  echo "Building auto-mobile..."
  bun run build
fi

# Warm up the daemon by calling daemon_available_devices
# This starts the daemon, initializes device pool, and waits for it to be ready
echo "Warming up daemon with device check..."
MAX_RETRIES=5
RETRY_DELAY=5

for i in $(seq 1 $MAX_RETRIES); do
  echo "Attempt $i/$MAX_RETRIES: Checking daemon availability..."
  if bun dist/src/index.js --cli daemon_available_devices --platform android 2>&1; then
    print_success "Daemon is ready and devices are available"
    break
  else
    if [ "$i" -eq "$MAX_RETRIES" ]; then
      print_warning "Daemon warm-up failed after $MAX_RETRIES attempts, proceeding anyway..."
    else
      echo "Daemon not ready yet, waiting ${RETRY_DELAY}s before retry..."
      sleep $RETRY_DELAY
    fi
  fi
done

# Return to android directory for test execution
cd android

echo ""

print_section "RUNNING TEST SCRIPT"

echo "Working directory: $(pwd)"
echo "About to execute: $TEST_SCRIPT"
echo ""

set +x  # Disable verbose output for cleaner test results
eval "$TEST_SCRIPT"
