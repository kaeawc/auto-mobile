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
            name: "CtrlProxy",
            targets: ["CtrlProxy"]
        ),
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

        // MARK: Reference implementation (behavioral oracle)

        // The shipped implementation. Pinned to Swift 5 language mode so it keeps
        // building as the parity oracle while `CtrlProxyRewrite` is brought up under
        // strict concurrency — a per-target mode avoids forcing the whole reference
        // (with its runOnMainThread/NSLock/@unchecked-Sendable debt) to migrate in
        // lockstep. It is retired once the rewrite reaches parity.
        .target(
            name: "CtrlProxy",
            dependencies: ["ObjCExceptionCatcher"],
            path: "Sources/CtrlProxy",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "CtrlProxyTests",
            dependencies: ["CtrlProxy"],
            path: "Tests/CtrlProxyTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),

        // MARK: Swift-6 concurrency-clean rewrite (in progress)

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
        // Differential parity + rewrite unit tests. Links BOTH the reference and the
        // rewrite so it can diff old vs new decode/encode behavior against the shared
        // wire fixture.
        .testTarget(
            name: "CtrlProxyRewriteTests",
            dependencies: ["CtrlProxy", "CtrlProxyRewrite", "CtrlProxyTestSupport"],
            path: "Tests/CtrlProxyRewriteTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
