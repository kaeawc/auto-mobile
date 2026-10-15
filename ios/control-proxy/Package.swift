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
    ],
    targets: [
        .target(
            name: "ObjCExceptionCatcher",
            path: "Sources/ObjCExceptionCatcher",
            publicHeadersPath: "include"
        ),

        // MARK: CtrlProxy

        .target(
            name: "CtrlProxy",
            dependencies: ["ObjCExceptionCatcher"],
            path: "Sources/CtrlProxy",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // Shared test doubles + fixtures for the implementation. NOT a dependency of the
        // shipped `.library`, so the product stays fake-free and Sendable-clean.
        .target(
            name: "CtrlProxyTestSupport",
            path: "Sources/CtrlProxyTestSupport",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // Unit tests and wire-contract golden/invariant tests using the shared
        // fixture `ios-ctrlproxy-request-snapshots.json`.
        .testTarget(
            name: "CtrlProxyTests",
            dependencies: ["CtrlProxy", "CtrlProxyTestSupport"],
            path: "Tests/CtrlProxyTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
