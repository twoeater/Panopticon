export const DEFAULT_TURN_TIMEOUT_SECONDS = 180;
export const MIN_TURN_TIMEOUT_SECONDS = 10;
export const MAX_TURN_TIMEOUT_SECONDS = 3600;
export const JOB_DELIVERY_GRACE_MS = 30000;
export const LEGACY_JOB_TIMEOUT_MS = 300000;
export function validTurnTimeout(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= MIN_TURN_TIMEOUT_SECONDS && Number(value) <= MAX_TURN_TIMEOUT_SECONDS;
}
