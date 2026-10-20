// swift-tools-version: 6.3
import PackageDescription

// An external module deliberately using only the published product and public API.
let package = Package(
    name: "EmbedConsumer",
    platforms: [.iOS(.v17)],
    products: [.library(name: "EmbedConsumer", targets: ["EmbedConsumer"])],
    dependencies: [.package(name: "auto-mobile", path: "../../../..")],
    targets: [
        .target(
            name: "EmbedConsumer",
            dependencies: [.product(name: "AutoMobilePrototype", package: "auto-mobile")]
        ),
    ]
)
