# In-app purchase testing

| Tool                         | What it does                                                    | Requires                             |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------ |
| 🛒 <code>storeKitTest</code> | Test in-app purchases with StoreKit Testing on an iOS simulator | <span class="tool-requires">—</span> |

`storeKitTest` drives StoreKit Testing on an iOS simulator: load a `.storekit` configuration,
then buy, refund, expire and list transactions without the App Store sandbox. It is off by
default; enable it with `setToolEnabled`.

## Parameters

| Parameter        | Action              | Meaning                                                                                                    |
| ---------------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `action`         | all                 | `load`, `buy`, `refund`, `expire`, `setTimeRate`, `setSimulatedError`, `disableDialogs`, `list` or `clear` |
| `appId`          | all                 | Bundle id that keys the session                                                                            |
| `configPath`     | `load`              | Absolute path of a `.storekit` file on the Mac running the simulator                                       |
| `productId`      | `buy`               | Product id from the configuration                                                                          |
| `transactionId`  | `refund`            | A transaction `identifier` from `list`                                                                     |
| `subscriptionId` | `expire`            | Subscription product id                                                                                    |
| `timeRate`       | `setTimeRate`       | A StoreKit renewal rate, such as `realTime` or `oneRenewalEveryTenSeconds`                                 |
| `simulatedError` | `setSimulatedError` | `unknown`, `paymentCancelled` or `storeProductNotAvailable`                                                |
| `enabled`        | `disableDialogs`    | `true` suppresses purchase dialogs                                                                         |

A missing argument for the action, or a `configPath` that is not an absolute `.storekit` path,
fails the call before anything reaches the device.

## Session

1. `load` starts the session: it resets StoreKit to its default state, clears transactions and
   disables purchase dialogs. Every other action needs a loaded session for that `appId`.
2. `buy`, `refund`, `expire`, `list` and `clear` return `transactions`, each with `identifier`,
   `productId`, `state` (`purchased`, `purchasing`, `failed`, `restored`, `deferred` or
   `unknown`) and `originalIdentifier` for renewals.
3. `setSimulatedError` makes the next `buy` fail with that error, and is cleared after it.
   Purchases the app starts itself keep failing until `clear` or another `load`.
4. `clear` resets the session, returns the final transactions and ends the session.

The session lasts as long as the runner. StoreKit Testing applies it to the runner's own target
app, so your app sees the purchases only when it runs as that target.

Two calls for the same `appId` cannot overlap: the second fails until the first finishes. Retry
it.

## Results

The result has `success`, `action`, `appId`, `transactions` when the action returns them, and
`error` when it failed.

`unsupported` is set, with nothing changed on the device, when StoreKit Testing cannot run:

| `unsupported`            | When                                               | What to do                      |
| ------------------------ | -------------------------------------------------- | ------------------------------- |
| `unsupported_platform`   | Android, Apple TV, Apple Watch or Apple Vision Pro | Use an iOS simulator            |
| `unsupported_device`     | A physical iPhone                                  | Use an iOS simulator            |
| `unsupported_capability` | The connected iOS runner predates StoreKit Testing | Restart the daemon to update it |
