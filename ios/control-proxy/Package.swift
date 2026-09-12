// swift-tools-version: 6.3
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "CtrlProxy",
    platforms: [
        .iOS(.v17),
        .macOS(.v15),
    ],
    products: [
        .library(
            name: "CtrlProxyRewrite",
            targets: ["CtrlProxyRewrite"]
        ),
    ],
    targets: [
        .target(
            name: "ObjCExceptionCatcher",
            path: "Sources/ObjCExceptionCatcher",
            publicHeadersPath: "include"
        ),

        // MARK: Swift-6 concurrency-clean rewrite (shipping)
        //
        // The reference `CtrlProxy` target (a Swift-5-language-mode behavioral oracle) and its
        // `CtrlProxyTests` were retired in Phase 7E once the rewrite reached parity and passed
        // on-device; the differential-parity harness (which linked both modules) was re-anchored
        // to reference-free golden/invariant tests or dropped. `CtrlProxyRewrite` is now the sole
        // implementation.

        .target(
            name: "CtrlProxyRewrite",
            dependencies: ["ObjCExceptionCatcher"],
            path: "Sources/CtrlProxyRewrite",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // Shared test doubles + fixtures for the rewrite. NOT a dependency of the
        // shipped `.library`, so the product stays fake-free and Sendable-clean.
        .target(
            name: "CtrlProxyTestSupport",
            path: "Sources/CtrlProxyTestSupport",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // Rewrite unit tests + reference-free wire-contract golden/invariant tests (the
        // differential-parity harness that once linked the reference module was retired in
        // Phase 7E — see the shared wire fixture `ios-ctrlproxy-request-snapshots.json`).
        .testTarget(
            name: "CtrlProxyRewriteTests",
            dependencies: ["CtrlProxyRewrite", "CtrlProxyTestSupport"],
            path: "Tests/CtrlProxyRewriteTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
