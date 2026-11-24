#if canImport(UIKit)
    import SwiftUI
    import UIKit

    @MainActor
    struct PrototypeRemoteImageView: View {
        let node: PrototypeNode
        let model: PrototypeModel
        let url: String
        @Environment(\.prototypePalette) private var palette
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var pixels: PrototypeRemoteImage?
        @State private var completedURL: String?
        @State private var failed = false

        private struct LoadKey: Hashable {
            let url: String
            let loader: ObjectIdentifier
        }

        private var state: String {
            guard completedURL == url else { return "loading" }
            return failed ? "error" : "loaded"
        }

        var body: some View {
            ZStack {
                if state == "loaded", let pixels {
                    sized(UIImage(cgImage: pixels.image)).transition(.opacity)
                } else {
                    fallback(state == "error" ? node.imageError : node.imagePlaceholder)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityValue(state)
            .task(id: LoadKey(url: url, loader: ObjectIdentifier(model.remoteImages))) {
                completedURL = nil
                pixels = nil
                failed = false
                do {
                    let delivery = PrototypeDeliveryCheck()
                    let image = try await model.remoteImages.load(url, delivery: delivery)
                    if let obsolete = delivery.obsoleteFailure() { throw obsolete }
                    try Task.checkCancellation()
                    withAnimation(node.crossfade == true && !reduceMotion ? .easeInOut(duration: 0.2) : nil) {
                        pixels = image
                        completedURL = url
                    }
                } catch {
                    guard !Task.isCancelled else { return }
                    failed = true
                    completedURL = url
                }
            }
        }

        @ViewBuilder
        private func sized(_ image: UIImage) -> some View {
            let resizable = Image(uiImage: image).resizable()
            switch node.contentScale {
            case "crop": resizable.aspectRatio(contentMode: .fill).clipped()
            case "fill": resizable
            default: resizable.aspectRatio(contentMode: .fit)
            }
        }

        @ViewBuilder
        private func fallback(_ value: JSONValue?) -> some View {
            if let id = value?.objectFields?["asset"]?.stringValue, let image = model.assets[id] {
                sized(image)
            } else if let color = value?.objectFields?["color"]?.stringValue, let resolved = palette.resolve(color) {
                Rectangle().fill(Color(resolved))
            } else {
                Rectangle().fill(Color.gray.opacity(0.3))
                    .overlay(Image(systemName: "photo").foregroundStyle(.secondary))
            }
        }
    }
#endif
