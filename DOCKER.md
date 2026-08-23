# Docker Quick Start

This project includes Docker support for running AutoMobile in a containerized environment with all required Android development tools.

## For MCP Clients (Claude Desktop, Continue.dev, etc.)

**Quick example for Claude Desktop**:

```json
{
  "mcpServers": {
    "auto-mobile": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "--init",
        "--privileged",
        "--network",
        "host",
        "auto-mobile:latest"
      ]
    }
  }
}
```

## For Development & Testing

```bash
# Build the image
docker-compose build

# Run in production mode
docker-compose up auto-mobile

# Run in development mode (with auto-reload)
docker-compose up auto-mobile-dev
```

## Pre-built Images

Published images are available on Docker Hub: [kaeawc/auto-mobile](https://hub.docker.com/r/kaeawc/auto-mobile)

```bash
# Pull latest version
docker pull kaeawc/auto-mobile:latest

# Pull specific version
docker pull kaeawc/auto-mobile:0.0.7

# Pull major.minor version (recommended for stability)
docker pull kaeawc/auto-mobile:0.0

# Pull specific commit
docker pull kaeawc/auto-mobile:main-abc1234
```

## What's Included

The Docker image contains:

- Bun 1.3.x
- Java 21
- Android SDK (API 36, Build Tools 35.0.0)
- Platform Tools (ADB)
- All required development tools (ripgrep, ktfmt, lychee, shellcheck, xmlstarlet)

To include Android emulator/system images, build with:

```bash
docker build --platform=linux/amd64 --build-arg ANDROID_INSTALL_EMULATOR=true -t auto-mobile:latest .
```

## Common Commands

```bash
# Interactive shell
docker-compose exec auto-mobile bash

# Run tests
docker-compose exec auto-mobile npm test

# Run linter
docker-compose exec auto-mobile npm run lint

# Check connected devices
docker-compose exec auto-mobile adb devices

# Build Android components
docker-compose exec auto-mobile bash -c "cd android && ./gradlew build"
```

## Requirements

- Docker Engine 20.10+
- Docker Compose v2.0+
- For ADB device access: Privileged mode and host networking (already configured)
- For slim images without emulator: Host Android SDK + AVDs mounted into the container

## Platform Notes

- **Linux**: Full support
- **macOS**: Limited ADB device access (Docker Desktop limitation). Use `--platform=linux/amd64` on Apple Silicon.
- **Windows**: Requires WSL2 with USB passthrough
- **iOS**: Not supported (requires macOS and Apple hardware)

## Troubleshooting

### Using the slim image

When the image is built without the emulator (`ANDROID_INSTALL_EMULATOR=false`), the container must still have
usable Android command-line tools available inside the container. AutoMobile no longer supports remoting from a
Docker container to host simulators or emulators.

**Linux (host SDK + emulator inside container):**

```bash
docker run --platform=linux/amd64 -it --rm --name auto-mobile \
  --network host \
  -e ANDROID_HOME=/opt/android-sdk \
  -e ANDROID_SDK_ROOT=/opt/android-sdk \
  -e AUTOMOBILE_EMULATOR_HEADLESS=true \
  -v "$HOME/Android/Sdk:/opt/android-sdk" \
  -v "$HOME/.android:/home/automobile/.android" \
  -v "$HOME/.auto-mobile:/home/automobile/.auto-mobile" \
  auto-mobile:latest
```

**macOS:** Docker Desktop cannot run macOS simulator binaries inside the Linux container, and AutoMobile does not
support Docker-to-host simulator/emulator control. Run AutoMobile directly on macOS for iOS simulator automation
or host-managed Android emulator workflows.

### ADB not seeing devices?

1. Ensure device is connected to host: `adb devices`
2. Restart ADB server: `adb kill-server && adb start-server`
3. Verify container runs with `--privileged` flag

### Build failing?

```bash
# Clean and rebuild
docker-compose down -v
docker-compose build --no-cache
docker-compose up
```

## Testing

### Validate Dockerfile

```bash
# Lint Dockerfile
./scripts/docker/validate_dockerfile.sh

# Run container structure tests
./scripts/docker/test_container.sh
```

### Test MCP stdio Protocol

```bash
# Build image
docker build --platform=linux/amd64 -t auto-mobile:latest .

# Test stdio communication
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | docker run --platform=linux/amd64 -i --rm --init auto-mobile:latest
```

For more help, see the sections above or check the [FAQ](docs/faq.md).
