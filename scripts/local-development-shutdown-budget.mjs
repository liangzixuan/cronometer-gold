export const nestedProcessTerminationGraceMs = 5_000;
export const serviceShutdownGraceMinimumMs = 100;
export const serviceShutdownGraceMaximumMs = 300_000;
export const serviceShutdownPhaseMaximum = 2;
export const supervisorTerminationMarginMs = 5_000;
export const localDevelopmentSupervisorGraceMaximumMs =
  serviceShutdownGraceMaximumMs * serviceShutdownPhaseMaximum + supervisorTerminationMarginMs;

export function parseServiceShutdownGraceMs(environment) {
  const value = environment.SHUTDOWN_GRACE_MS;
  const parsed = Number(value);
  if (
    typeof value !== "string" ||
    !Number.isSafeInteger(parsed) ||
    parsed < serviceShutdownGraceMinimumMs ||
    parsed > serviceShutdownGraceMaximumMs ||
    String(parsed) !== value
  ) {
    throw new Error("Local development requires an exact bounded SHUTDOWN_GRACE_MS");
  }
  return parsed;
}

export function localDevelopmentSupervisorGraceMs(serviceGraceMs, serviceShutdownPhases = 2) {
  if (
    !Number.isSafeInteger(serviceGraceMs) ||
    serviceGraceMs < serviceShutdownGraceMinimumMs ||
    serviceGraceMs > serviceShutdownGraceMaximumMs ||
    !Number.isSafeInteger(serviceShutdownPhases) ||
    serviceShutdownPhases < 1 ||
    serviceShutdownPhases > serviceShutdownPhaseMaximum
  ) {
    throw new Error("Local development requires a bounded service shutdown grace period");
  }
  return (
    Math.max(serviceGraceMs * serviceShutdownPhases, nestedProcessTerminationGraceMs) +
    supervisorTerminationMarginMs
  );
}
