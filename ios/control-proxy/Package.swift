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
    dependencies: [
        .package(path: "../sdk-wire"),
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
            dependencies: [
                "ObjCExceptionCatcher",
                .product(name: "AutoMobileSdkWire", package: "sdk-wire"),
            ],
            path: "Sources/CtrlProxy",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // Pure tvOS policy is separate from the shipped iOS library.
        .target(
            name: "TVCommandPolicy",
            path: "Tests/CtrlProxyTVUITests",
            exclude: ["CtrlProxyTVUITests.swift", "TVCommandRouter.swift", "TVWebSocketServer.swift"],
            sources: ["TVCommandPolicy.swift", "ConnectedEvent.swift"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "TVCommandPolicyTests",
            dependencies: ["TVCommandPolicy", "CtrlProxy"],
            path: "Tests/TVCommandPolicyTests",
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
            dependencies: [
                "CtrlProxy",
                "CtrlProxyTestSupport",
                .product(name: "AutoMobileSdkWire", package: "sdk-wire"),
            ],
            path: "Tests/CtrlProxyTests",
            resources: [.copy("Fixtures")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
