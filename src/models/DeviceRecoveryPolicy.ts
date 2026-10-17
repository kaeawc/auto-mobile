export interface DeviceRecoveryPolicy {
  onLoss: boolean;
  maxAttempts: number;
}
