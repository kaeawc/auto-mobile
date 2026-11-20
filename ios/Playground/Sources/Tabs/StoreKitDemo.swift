import AutoMobileSDK
import StoreKit
import SwiftUI

enum StoreKitDemoFormatting {
    static func entitlementsText(_ productIDs: Set<String>) -> String {
        productIDs.isEmpty ? "none" : productIDs.sorted().joined(separator: ", ")
    }
}

@MainActor
struct StoreKitDemo: View {
    private nonisolated static let productIDs: Set<String> = [
        "dev.jasonpearson.automobile.playground.coins",
        "dev.jasonpearson.automobile.playground.pro",
        "dev.jasonpearson.automobile.playground.plus",
    ]

    @State private var products: [Product] = []
    @State private var entitlements: Set<String> = []
    @State private var entitlementRefresh = 0
    @State private var purchaseStatus = "no purchase yet"
    @State private var productLoadError: String?
    @State private var isRefreshing = false
    @State private var isPurchasing = false

    var body: some View {
        List {
            Section("Products") {
                Text("products: \(products.count)")
                    .accessibilityIdentifier("storekit.products")

                if let productLoadError {
                    Text("Product load failed: \(productLoadError)")
                }

                ForEach(products, id: \.id) { product in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(product.displayName)
                            Text(product.displayPrice)
                        }
                        Spacer()
                        Button("Buy") {
                            Task { await purchase(product) }
                        }
                        .buttonStyle(.bordered)
                        .accessibilityLabel("Buy \(product.displayName)")
                        .accessibilityIdentifier("storekit.buy.\(product.id)")
                        .disabled(isPurchasing)
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("storekit.product.\(product.id)")
                }

                Button("Refresh") {
                    Task { await refresh() }
                }
                .accessibilityIdentifier("storekit.refresh")
                .disabled(isRefreshing)
            }

            Section("Last purchase") {
                Text(verbatim: purchaseStatus)
                    .accessibilityIdentifier("storekit.status")
            }

            Section("Entitlements") {
                Text(verbatim: StoreKitDemoFormatting.entitlementsText(entitlements))
                    .accessibilityIdentifier("storekit.entitlements")
            }
        }
        .playgroundContent()
        .navigationTitle("StoreKit")
        .navigationBarTitleDisplayMode(.inline)
        .trackNavigation(destination: "StoreKitDemo")
        .task { await listenForTransactions() }
        .task { await refresh() }
    }

    private func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let loadedProducts = try await Product.products(for: Self.productIDs)
            guard !Task.isCancelled else { return }
            products = loadedProducts.sorted { $0.id < $1.id }
            productLoadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            productLoadError = error.localizedDescription
        }

        await refreshEntitlements()
    }

    private func refreshEntitlements() async {
        entitlementRefresh += 1
        let refresh = entitlementRefresh
        let productIDs = await Self.readEntitlements()
        // A purchase or update can start a newer read while this sequence is suspended.
        guard !Task.isCancelled, refresh == entitlementRefresh else { return }
        entitlements = productIDs
    }

    private nonisolated static func readEntitlements() async -> Set<String> {
        var productIDs: Set<String> = []
        for await result in StoreKit.Transaction.currentEntitlements {
            if case let .verified(transaction) = result, Self.productIDs.contains(transaction.productID) {
                productIDs.insert(transaction.productID)
            }
        }
        return productIDs
    }

    private func purchase(_ product: Product) async {
        guard !isPurchasing else { return }
        isPurchasing = true
        defer { isPurchasing = false }

        do {
            switch try await product.purchase() {
            case let .success(.verified(transaction)):
                await refreshEntitlements()
                await transaction.finish()
                purchaseStatus = "purchased: \(transaction.productID)"
            case .success(.unverified):
                purchaseStatus = "unverified: \(product.id)"
            case .pending:
                purchaseStatus = "pending: \(product.id)"
            case .userCancelled:
                purchaseStatus = "cancelled: \(product.id)"
            @unknown default:
                purchaseStatus = "unknown result: \(product.id)"
            }
        } catch {
            purchaseStatus = "purchase failed: \(error.localizedDescription)"
        }
    }

    private nonisolated func listenForTransactions() async {
        for await result in StoreKit.Transaction.updates {
            guard case let .verified(transaction) = result, Self.productIDs.contains(transaction.productID) else {
                continue
            }
            await refreshEntitlements()
            await transaction.finish()
        }
    }
}
