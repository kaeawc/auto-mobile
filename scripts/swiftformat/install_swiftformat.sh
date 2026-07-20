#!/usr/bin/env bash

# Shared colors + command_exists + detect_os/detect_arch (issue #2822).
# Note: SwiftFormat intentionally ships only macOS/Linux paths; detect_os may
# return "windows" but main() routes that to the unsupported branch.
# shellcheck source=scripts/lib/tool-install.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib/tool-install.sh"
# shellcheck source=scripts/swiftformat/swiftformat_version.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/swiftformat_version.sh"

# Install SwiftFormat on macOS
install_macos() {
    install_via_brew_or_manual "SwiftFormat" "swiftformat" install_manual is_pinned_swiftformat_version
    return $?
}

# Install SwiftFormat on Linux
install_linux() {
    echo -e "${YELLOW}Installing SwiftFormat on Linux...${NC}"
    echo -e "${YELLOW}SwiftFormat requires manual installation on Linux...${NC}"
    install_manual
    return $?
}

# Manual installation by downloading binary
install_manual() {
    echo -e "${YELLOW}Installing SwiftFormat manually...${NC}"

    # Create installation directory
    install_dir="$HOME/.local/bin"
    mkdir -p "$install_dir"
    export PATH="$install_dir:$PATH"

    os=$(detect_os)

    if [[ "$os" == "macos" ]]; then
        # Download from GitHub releases
        download_url="https://github.com/nicklockwood/SwiftFormat/releases/download/${SWIFTFORMAT_VERSION}/swiftformat_macos.zip"
        temp_dir=$(mktemp -d)
        trap 'rm -rf "$temp_dir"' EXIT

        echo -e "${GREEN}Downloading SwiftFormat from GitHub...${NC}"

        # -f/--fail: an HTTP error (e.g. 404) must fail, not save the error
        # page as the "archive". Each install step is checked so a failed
        # download/extract/move returns non-zero instead of reporting success
        # from the unconditional `return 0` below (#3649).
        if command_exists curl; then
            if ! curl -fL -o "$temp_dir/swiftformat.zip" "$download_url"; then
                echo -e "${RED}Failed to download SwiftFormat${NC}"
                return 1
            fi
        elif command_exists wget; then
            if ! wget -O "$temp_dir/swiftformat.zip" "$download_url"; then
                echo -e "${RED}Failed to download SwiftFormat${NC}"
                return 1
            fi
        else
            echo -e "${RED}Neither curl nor wget found. Please install one of them.${NC}"
            return 1
        fi

        # Extract and install
        if ! unzip -o "$temp_dir/swiftformat.zip" -d "$temp_dir"; then
            echo -e "${RED}Failed to extract SwiftFormat archive${NC}"
            return 1
        fi
        if ! mv "$temp_dir/swiftformat" "$install_dir/swiftformat"; then
            echo -e "${RED}Failed to install SwiftFormat binary${NC}"
            return 1
        fi
        chmod +x "$install_dir/swiftformat"

        echo -e "${GREEN}SwiftFormat installed successfully to $install_dir${NC}"
    else
        # For Linux, need to build from source or use Swift Package Manager
        echo -e "${YELLOW}On Linux, SwiftFormat needs to be built from source.${NC}"
        echo -e "${YELLOW}Please install Swift first, then run:${NC}"
        echo "git clone https://github.com/nicklockwood/SwiftFormat.git"
        echo "cd SwiftFormat"
        echo "swift build -c release"
        echo "cp .build/release/swiftformat $install_dir/"
        return 1
    fi

    # Check if directory is in PATH
    if [[ ":$PATH:" != *":$install_dir:"* ]]; then
        echo -e "${YELLOW}To add $install_dir to your PATH, add this line to your shell configuration:${NC}"
        echo "export PATH=\"\$PATH:$install_dir\""
    fi

    return 0
}

# Verify installation
verify_installation() {
    echo -e "${YELLOW}Verifying SwiftFormat installation...${NC}"

    if command_exists swiftformat; then
        echo -e "${GREEN}SwiftFormat is installed and available in PATH${NC}"
        swiftformat --version 2>/dev/null || echo -e "${GREEN}SwiftFormat is ready to use${NC}"
        return 0
    else
        echo -e "${RED}SwiftFormat is not available in PATH${NC}"
        return 1
    fi
}

# Main installation function
main() {
    echo -e "${GREEN}SwiftFormat Installation Script${NC}"
    echo -e "${GREEN}================================${NC}"

    os=$(detect_os)
    echo -e "${YELLOW}Detected OS: $os${NC}"

    case $os in
        macos)
            install_macos
            ;;
        linux)
            install_linux
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
