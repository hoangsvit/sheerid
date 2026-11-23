// Copy only deliberate response metadata; never serialize full HTTP bodies.
export function responseDetails(value) {
  const keys = ['httpStatus', 'terminal', 'currentStep', 'errorIds', 'rejectionReasons',
    'stateConfirmed', 'stateCheckedAt', 'lastKnownStep', 'lastKnownAt', 'retryAfterSeconds',
    'responseErrorIds', 'responseRejectionReasons'];
  return Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
}
