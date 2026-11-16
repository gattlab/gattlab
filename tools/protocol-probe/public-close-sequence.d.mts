export declare const MAX_CLOSE_STEPS = 3;
export declare const MODEL_COMMAND_WATCHDOG_MS = 30000;
export declare function isDestructiveRegistration(row: {
  group: string;
  action: string;
  level: string;
  subject: string;
  retainedFixture?: boolean;
}): boolean;
export interface ModelTimeoutEvidence {
  causeType: string;
  code: string;
  operation: string;
  operationLayer: string;
  deadlineKind: string;
  timeoutPhase: string;
  deadlineMs: number;
  checkDeadlineMs: number;
  detection: string;
  centralStateBlocked: boolean;
  remediation: string;
  causeRetained: boolean;
}
export declare function assertModelTimeoutEvidence(evidence: unknown): void;
export declare function assertModelCommandAbort(
  cause: unknown,
  expected: { operation: string; boundary: string; retainedCause?: unknown },
  types: {
    stopped: typeof import('@gattlab/core').BluetoothBackendStoppedError;
    timeout: typeof import('@gattlab/core').BluetoothTimeoutError;
  },
): {
  timeout: import('@gattlab/core').BluetoothTimeoutError;
  evidence: ModelTimeoutEvidence;
};
export type PublicCloseOutcome =
  | {
      outcome: 'invalidated';
      steps: number;
      verifiedRegistrations: number;
      cause: unknown;
    }
  | { outcome: 'continued'; steps: number; verifiedRegistrations: number };
export declare function observePublicClose<T>(
  register: (step: number) => Promise<T>,
  verifyRegistration: (value: T, step: number) => void,
  verifyLoss: (cause: unknown) => void,
): Promise<PublicCloseOutcome>;
