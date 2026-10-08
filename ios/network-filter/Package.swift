// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SimulatorNetworkFilter",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "network-filter-controller", targets: ["NetworkFilterController"]),
        .executable(name: "network-filter-provider", targets: ["NetworkFilterProvider"]),
    ],
    targets: [
        // libbsm provides audit_token_to_pid and audit_token_to_pidversion.
        .target(name: "NetworkFilterCore", linkerSettings: [.linkedLibrary("bsm")]),
        .executableTarget(name: "NetworkFilterController", dependencies: ["NetworkFilterCore"]),
        .executableTarget(name: "NetworkFilterProvider", dependencies: ["NetworkFilterCore"]),
        .testTarget(name: "NetworkFilterCoreTests", dependencies: ["NetworkFilterCore"]),
    ]
)
