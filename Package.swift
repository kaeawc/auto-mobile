// swift-tools-version: 6.3
import PackageDescription

/// This root manifest is the published SPM entry point (consumers add the repo URL and pick the
/// `XCTestRunner` / `AutoMobileSDK` / `AutoMobilePrototype` products). The `XCTestRunner` target
/// compiles the same sources as ios/XCTestRunner, which now depend on Tachikoma for AI-assisted
/// recovery — so the dependency,
/// Swift 6.0 tools, and the iOS 17 / macOS 15 floor are declared here too. Every target compiles in
/// the Swift 6 language mode (the default under swift-tools-version 6.3), matching the per-package
/// manifests under ios/ (#5839).
let package = Package(
    name: "auto-mobile",
    platforms: [
        .iOS(.v17),
        .macOS(.v15),
    ],
    products: [
        .library(
            name: "AutoMobilePrototype",
            targets: ["AutoMobilePrototype"]
        ),
        .library(
            name: "AutoMobileSDK",
            targets: ["AutoMobileSDK"]
        ),
        .library(
            name: "XCTestRunner",
            targets: ["XCTestRunner"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-docc-plugin", from: "1.4.3"),
        // Powers AI-assisted recovery in XCTestRunner. Pinned to an exact tag for reproducible builds.
        .package(url: "https://github.com/steipete/Tachikoma.git", exact: "1.0.0"),
        // Parses plan YAML in XCTestRunner (metadata, secret keys, parameter substitution) instead of
        // hand-rolled line scanners (#11889). Pinned to an exact tag like Tachikoma.
        .package(url: "https://github.com/jpsim/Yams.git", exact: "6.2.2"),
    ],
    targets: [
        // Core and renderer share a module, preserving the embedded API's existing visibility.
        .target(
            name: "AutoMobilePrototype",
            path: "ios/prototype-agent/Sources",
            exclude: [
                "AutoMobilePrototypeAgent/Loader.c",
                "AutoMobilePrototypeAgent/PrototypeAgent.swift",
                "AutoMobilePrototypeAgent/PrototypeServer.swift",
            ],
            // Required-reason API declarations travel with the library so embedders inherit them (#14151).
            resources: [.process("PrivacyInfo.xcprivacy")]
        ),
        .target(
            name: "AutoMobileHighlightCore",
            path: "ios/highlight-core/Sources/AutoMobileHighlightCore"
        ),
        .target(
            name: "AutoMobileSdkWire",
            path: "ios/sdk-wire/Sources/AutoMobileSdkWire"
        ),
        .target(
            name: "AutoMobileSDK",
            dependencies: ["AutoMobileHighlightCore", "AutoMobileSdkWire"],
            path: "ios/auto-mobile-sdk/Sources/AutoMobileSDK",
            resources: [.process("PrivacyInfo.xcprivacy")]
        ),
        .target(
            name: "XCTestRunner",
            dependencies: [
                .product(name: "Tachikoma", package: "Tachikoma"),
                .product(name: "Yams", package: "Yams"),
            ],
            path: "ios/XCTestRunner/Sources/XCTestRunner"
        ),
    ]
)
