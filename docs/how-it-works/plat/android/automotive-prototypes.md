# Automotive prototypes

Car-specific prototypes are not supported on Android Automotive OS (AAOS) (#16747, epic #14915).
AAOS shows the same phone-style prototypes as other Android devices, laid out for the landscape car
display; [Android Automotive](prototype-ux-windows.md#android-automotive) describes that behaviour.
The spec has no Car App Library template nodes or other car-specific nodes, and no renderer or
validator treats a car display specially beyond its insets.

An app built on the Car App Library mostly cannot draw custom UI: the car host renders its templates.
A template-faithful prototype therefore needs a different rendering path than the in-app overlay.

## Background

- [Defer car-specific prototypes on AAOS](../../../devlog/2026-11-07-automotive-prototypes-deferred.md)
