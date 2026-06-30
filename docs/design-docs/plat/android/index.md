# Overview

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> See the [Status Glossary](../../status-glossary.md) for chip definitions.

AutoMobile's Android stack spans the MCP server, daemon, IDE plugin, JUnitRunner, Desktop companion app, and device-side services.

## Test Execution

The Android JUnitRunner executes AutoMobile tests on devices and emulators. It extends the standard
Android testing framework with richer reporting and tighter MCP integration, with a long-term goal of
self-healing test flows.

## Android Accessibility Service

The Android Accessibility Service provides real-time access to view hierarchy data and UI elements without
rooting or special permissions beyond accessibility enablement. When enabled, it monitors UI changes,
stores the latest hierarchy in app-private storage, and streams updates over WebSocket.

For **`tapOn`** reliability when the UI churns between **`observe`** and tap (search lists, loading overlays), see **[Android `tapOn` pre-tap stability and search flakes](tapOn-pre-tap-stability-and-search-flakes.md)**.

## AutoMobile SDK

The [AutoMobile SDK](auto-mobile-sdk.md) provides Android-specific components for integrating AutoMobile
into applications and test suites. Beyond the core JUnitRunner and Accessibility Service, the SDK includes
an event pipeline, crash and ANR handling, session tracking, Compose recomposition tracking, navigation
adapters, SQLite and SharedPreferences inspection, and notification triggering.

## Desktop Companion App

The Desktop companion app is a Compose Desktop application for monitoring and controlling AutoMobile
sessions from a developer workstation. It provides a graphical interface for viewing connected devices,
inspecting view hierarchies, and triggering actions without requiring the CLI or MCP client.

The app lives under `android/desktop-app/`, with shared logic in `android/desktop-core/` and domain
models in `android/desktop-domain/`. It uses Metro for dependency injection and connects to the
AutoMobile daemon via HTTP, stdio, or socket transport.

See [Desktop App](desktop-app.md) for full details.

## Emulator Startup

AutoMobile cold-starts Android emulators on demand and auto-detects whether the host
has a usable display, defaulting to headless (`-no-window`) on headless Linux hosts
such as CI runners. See [Emulator Startup & Headless Hosts](emulator-startup.md) for
the display-mode rules and the `AUTOMOBILE_EMULATOR_*` environment variables.

## Batteries Included

AutoMobile includes tooling to minimize setup for required platform dependencies.
