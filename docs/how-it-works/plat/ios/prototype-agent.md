# iOS simulator prototype agent

Agent-authored prototypes (milestone 37, #9295) on iOS simulators, with no SDK in the
target app. iOS counterpart of the [Android prototype specification](../android/prototype-ux.md);
the spec, validation limits and node vocabulary are shared. Epic #10563.

Items marked "not device-verified" have unit coverage only. `scripts/ios/prototype-agent-demo.ts` is
a standalone driver.

The agent's contract is split across these pages:

- [Native look and feature support](prototype-agent-native-look.md)
- [How it works, limits, entry point and Android differences](prototype-agent-runtime.md)
- [Appearance, anchors and Material components](prototype-agent-components.md)
- [Data, storage and network](prototype-agent-data.md)
- [Layout and component contracts](prototype-agent-contracts.md)
- [Saved prototypes, sharing and effects](prototype-agent-saved.md)

## Background

- [iOS prototype agent decisions](../../../devlog/2026-10-09-prototype-agent-ios-decisions.md)
- [iOS prototype agent verification backlog](../../../devlog/2026-10-08-prototype-agent-ios-verification-backlog.md)
