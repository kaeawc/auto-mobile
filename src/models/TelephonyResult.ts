export type PhoneCallAction = "call" | "accept" | "cancel" | "busy" | "hold";

export interface PhoneCallResult {
  success: boolean;
  action: PhoneCallAction;
  phoneNumber?: string;
  supported: boolean;
  message?: string;
  error?: string;
}

export interface SendSmsResult {
  success: boolean;
  phoneNumber: string;
  messageLength: number;
  supported: boolean;
  message?: string;
  error?: string;
}
