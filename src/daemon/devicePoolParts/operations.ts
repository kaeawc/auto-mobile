import type { InitializationOperations } from "./initialization";
import type { AllocationWiringOperations } from "./allocationWiring";
import type { LifecycleWiringOperations } from "./lifecycleWiring";
import type { RecoveryWiringOperations } from "./recoveryWiring";
import type { MembershipOperations } from "./membership";
import type { RestartStopsOperations } from "./restartStops";
import type { MultiAllocationOperations } from "./multiAllocation";
import type { StartupOperations } from "./startup";
import type { PresenceOperations } from "./presence";
import type { SessionRecoveryOperations } from "./sessionRecovery";
import type { AndroidRecoveryOperations } from "./androidRecovery";
import type { EmulatorLifecycleOperations } from "./emulatorLifecycle";
import type { AssignmentOperations } from "./assignment";
import type { AllocationHealthOperations } from "./allocationHealth";
import type { ReleaseOperations } from "./release";
import type { ReplacementOperations } from "./replacement";
import type { ReservationsOperations } from "./reservations";
import type { AvailabilityOperations } from "./availability";
import type { TargetDiscoveryOperations } from "./targetDiscovery";
import type { ConnectionClaimsOperations } from "./connectionClaims";
import type { DiscoveryOperations } from "./discovery";
import type { ConnectionSessionsOperations } from "./connectionSessions";
import type { StatusOperations } from "./status";
import type { BindingOperations } from "./binding";
import type { RecoveryEvidenceOperations } from "./recoveryEvidence";
import type { ReportingOperations } from "./reporting";

export interface DevicePoolOperations
  extends
    InitializationOperations,
    AllocationWiringOperations,
    LifecycleWiringOperations,
    RecoveryWiringOperations,
    MembershipOperations,
    RestartStopsOperations,
    MultiAllocationOperations,
    StartupOperations,
    PresenceOperations,
    SessionRecoveryOperations,
    AndroidRecoveryOperations,
    EmulatorLifecycleOperations,
    AssignmentOperations,
    AllocationHealthOperations,
    ReleaseOperations,
    ReplacementOperations,
    ReservationsOperations,
    AvailabilityOperations,
    TargetDiscoveryOperations,
    ConnectionClaimsOperations,
    DiscoveryOperations,
    ConnectionSessionsOperations,
    StatusOperations,
    BindingOperations,
    RecoveryEvidenceOperations,
    ReportingOperations {}
