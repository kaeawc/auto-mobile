// swift-tools-version: 6.3
import PackageDescription

// Standalone benchmark package for ScreenCaptureCore's per-frame byte transforms.
//
// Deliberately SEPARATE from ../Package.swift so the shipped `screen-capture` package
// never takes a dependency on package-benchmark (and its jemalloc/pkg-config system
// requirement): `scripts/ios/swift-build.sh` builds only the shipped package, so CI is
// unaffected. Run locally with:
//
//   swift package --package-path ios/screen-capture/Benchmarks --disable-sandbox \
//     --allow-writing-to-package-directory benchmark
//
// package-benchmark reports allocation counts (via jemalloc), which is the metric that
// most directly demonstrates the per-frame copy/alloc elimination in this pass.
let package = Package(
    name: "ScreenCaptureBenchmarks",
    platforms: [
        .macOS(.v15),
    ],
    dependencies: [
        .package(path: ".."),
        .package(url: "https://github.com/ordo-one/benchmark", from: "1.4.0"),
    ],
    targets: [
        .executableTarget(
            name: "ScreenCaptureCoreBenchmarks",
            dependencies: [
                .product(name: "ScreenCaptureCore", package: "screen-capture"),
                .product(name: "Benchmark", package: "benchmark"),
            ],
            path: "Benchmarks/ScreenCaptureCoreBenchmarks",
            plugins: [
                .plugin(name: "BenchmarkPlugin", package: "benchmark"),
            ]
        ),
    ]
)
