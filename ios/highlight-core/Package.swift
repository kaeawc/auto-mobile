// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AutoMobileHighlightCore",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [.library(name: "AutoMobileHighlightCore", targets: ["AutoMobileHighlightCore"])],
    targets: [
        .target(name: "AutoMobileHighlightCore"),
        .testTarget(name: "AutoMobileHighlightCoreTests", dependencies: ["AutoMobileHighlightCore"]),
    ]
)
