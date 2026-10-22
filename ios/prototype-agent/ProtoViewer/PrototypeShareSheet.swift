import SwiftUI
import UIKit

@MainActor
struct PrototypeShareSheet: UIViewControllerRepresentable {
    let url: URL
    let completed: @MainActor (Error?) -> Void

    func makeUIViewController(context _: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, error in
            Task { @MainActor in completed(error) }
        }
        return controller
    }

    func updateUIViewController(_: UIActivityViewController, context _: Context) {}
}
