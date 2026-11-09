#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=scripts/hadolint/hadolint_version.sh
source "$(dirname "${BASH_SOURCE[0]}")/hadolint_version.sh"
# Cached, checksum-verified, backed-off release download (#17641).
# shellcheck source=scripts/lib/release-download.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/release-download.sh"

# Shared colors + command_exists + detect_os/detect_arch (issue #2822).
# shellcheck source=scripts/lib/tool-install.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/tool-install.sh"

# Run a command the way an `if` condition would (errexit is ignored inside it)
# and record its exit status in RUN_STATUS, so callers can branch on it without
# a function name in a condition.
RUN_STATUS=0
run_capture_status() {
  local run_rc=0
  "$@" || run_rc=$?
  RUN_STATUS="${run_rc}"
}

# Install hadolint on macOS
install_macos() {
    install_via_brew_or_manual "hadolint" "hadolint" install_manual
    return $?
}

# Install hadolint on Linux
install_linux() {
    echo -e "${YELLOW}Installing hadolint on Linux...${NC}"

    # Check for package managers in order of preference
    if command -v apt-get >/dev/null 2>&1; then
        echo -e "${YELLOW}APT package manager detected, but hadolint may not be available in default repositories.${NC}"
        echo -e "${YELLOW}Falling back to manual installation...${NC}"
        install_manual
        return $?
    elif command -v yum >/dev/null 2>&1; then
        echo -e "${YELLOW}YUM package manager detected, but hadolint may not be available in default repositories.${NC}"
        echo -e "${YELLOW}Falling back to manual installation...${NC}"
        install_manual
        return $?
    elif command -v dnf >/dev/null 2>&1; then
        echo -e "${YELLOW}DNF package manager detected, but hadolint may not be available in default repositories.${NC}"
        echo -e "${YELLOW}Falling back to manual installation...${NC}"
        install_manual
        return $?
    elif command -v pacman >/dev/null 2>&1; then
        echo -e "${YELLOW}Pacman package manager detected, but hadolint may not be available in default repositories.${NC}"
        echo -e "${YELLOW}Falling back to manual installation...${NC}"
        install_manual
        return $?
    else
        echo -e "${YELLOW}No supported package manager found. Using manual installation...${NC}"
        install_manual
        return $?
    fi
}

# Install hadolint on Windows
install_windows() {
    echo -e "${YELLOW}Installing hadolint on Windows...${NC}"

    if command -v scoop >/dev/null 2>&1; then
        echo -e "${GREEN}Using Scoop to install hadolint${NC}"
        scoop install hadolint
        return $?
    elif command -v choco >/dev/null 2>&1; then
        echo -e "${YELLOW}Chocolatey detected, but hadolint may not be available. Falling back to manual installation...${NC}"
        install_manual
        return $?
    elif command -v winget >/dev/null 2>&1; then
        echo -e "${YELLOW}Winget detected, but hadolint may not be available. Falling back to manual installation...${NC}"
        install_manual
        return $?
    else
        echo -e "${YELLOW}No supported package manager found. Using manual installation...${NC}"
        echo -e "${YELLOW}Consider installing Scoop for easier package management: https://scoop.sh/${NC}"
        install_manual
        return $?
    fi
}

# Manual installation by downloading binary
install_manual() {
    echo -e "${YELLOW}Installing hadolint manually...${NC}"

    local os
    os=$(detect_os)
    local arch
    arch=$(detect_arch)

    # Map OS and architecture to GitHub release naming
    case "$os" in
        macos)
            os_name="Darwin"
            ;;
        linux)
            os_name="Linux"
            ;;
        windows)
            os_name="Windows"
            ;;
        *)
            echo -e "${RED}Unsupported operating system: $os${NC}"
            return 1
            ;;
    esac

    case "$arch" in
        x86_64)
            arch_name="x86_64"
            ;;
        arm64)
            arch_name="arm64"
            ;;
        *)
            echo -e "${RED}Unsupported architecture: $arch${NC}"
            return 1
            ;;
    esac

    # hadolint publishes no Darwin-arm64 asset (v2.12.0 ships only Darwin-x86_64);
    # Apple Silicon runs the x86_64 build under Rosetta 2. Without this remap the
    # download URL 404s on Apple Silicon. (#3641)
    if [[ "$os_name" == "Darwin" && "$arch_name" == "arm64" ]]; then
        echo -e "${YELLOW}No native Darwin-arm64 hadolint build; using x86_64 (Rosetta 2).${NC}"
        arch_name="x86_64"
    fi

    # Create installation directory
    install_dir="$HOME/.local/bin"
    mkdir -p "$install_dir"

    # Download URL. The Windows asset carries an .exe suffix.
    binary_name="hadolint-${os_name}-${arch_name}"
    if [[ "$os_name" == "Windows" ]]; then
        binary_name="${binary_name}.exe"
    fi
    download_url="$(hadolint_release_url "$binary_name")"

    local expected_sha
    expected_sha="$(hadolint_release_sha256 "$binary_name")"
    if [[ -z "$expected_sha" ]]; then
        echo -e "${RED}No pinned checksum for hadolint ${HADOLINT_VERSION} asset ${binary_name}; add it to hadolint_version.sh.${NC}"
        return 1
    fi

    echo -e "${GREEN}Fetching hadolint ${HADOLINT_VERSION} from GitHub releases...${NC}"
    echo "URL: $download_url"

    # Create temporary directory
    temp_dir=$(mktemp -d)
    trap 'rm -rf "$temp_dir"' EXIT

    # Reuses a cached binary whose SHA-256 matches the pin, else downloads with
    # a bounded backoff (curl -f, so a 404 page is never installed, #3641) and
    # verifies the checksum before installing or caching.
    run_capture_status release_fetch_pinned "$download_url" "$expected_sha" "$temp_dir/hadolint" "hadolint/${HADOLINT_VERSION}"
    if [[ "$RUN_STATUS" -ne 0 ]]; then
        echo -e "${RED}Failed to download hadolint binary${NC}"
        return 1
    fi

    # Make executable and move to install directory
    chmod +x "$temp_dir/hadolint"
    mv "$temp_dir/hadolint" "$install_dir/hadolint"

    echo -e "${GREEN}hadolint installed successfully to $install_dir${NC}"
    echo -e "${YELLOW}Make sure $install_dir is in your PATH environment variable.${NC}"

    # Check if directory is in PATH
    if [[ ":$PATH:" != *":$install_dir:"* ]]; then
        echo -e "${YELLOW}To add $install_dir to your PATH, add this line to your shell configuration:${NC}"
        echo "export PATH=\"\$PATH:$install_dir\""
    fi

    return 0
}

# Verify installation
verify_installation() {
    echo -e "${YELLOW}Verifying hadolint installation...${NC}"

    if command -v hadolint >/dev/null 2>&1; then
        echo -e "${GREEN}hadolint is installed and available in PATH${NC}"
        hadolint --version
        return 0
    else
        echo -e "${RED}hadolint is not available in PATH${NC}"
        return 1
    fi
}

# Main installation function
main() {
    echo -e "${GREEN}Hadolint Installation Script${NC}"
    echo -e "${GREEN}============================${NC}"

    # Check if hadolint is already installed
    if command -v hadolint >/dev/null 2>&1; then
        echo -e "${GREEN}hadolint is already installed${NC}"
        hadolint --version
        echo -e "${YELLOW}To reinstall, remove the existing installation first${NC}"
        exit 0
    fi

    local os
    os=$(detect_os)
    local arch
    arch=$(detect_arch)
    echo -e "${YELLOW}Detected OS: $os${NC}"
    echo -e "${YELLOW}Detected Architecture: $arch${NC}"

    case $os in
        macos)
            install_macos
            ;;
        linux)
            install_linux
            ;;
        windows)
            install_windows
            ;;
        *)
            echo -e "${RED}Unsupported operating system: $os${NC}"
            echo -e "${YELLOW}Falling back to manual installation...${NC}"
            install_manual
            ;;
    esac

    install_result=$?

    if [[ $install_result -eq 0 ]]; then
        echo -e "${GREEN}Installation completed successfully!${NC}"
        verify_installation
    else
        echo -e "${RED}Installation failed!${NC}"
        exit 1
    fi
}

# Run main function
main "$@"
