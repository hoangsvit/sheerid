import { AutomationError } from '../../core/errors.js';
import { isRecord } from '../../core/config.js';

function validCodes(codes) {
  return Array.isArray(codes) && codes.length <= 50
    && codes.every(code => typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(code));
}

export function parseVerification(body, verificationId) {
  const errorIds = body?.errorIds ?? [];
  const rejectionReasons = body?.rejectionReasons ?? [];
  if (!isRecord(body) || typeof body.verificationId !== 'string'
    || body.verificationId.toLowerCase() !== verificationId
    || typeof body.currentStep !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(body.currentStep)
    || !validCodes(errorIds) || !validCodes(rejectionReasons)) {
    throw new AutomationError('API_RESPONSE_INVALID', 'Invalid API fields or mismatched verification ID; workflow stopped');
  }
  return { currentStep: body.currentStep, errorIds, rejectionReasons };
}

export function verificationErrorDetails(body, verificationId) {
  const unknown = { stateConfirmed: false };
  if (!isRecord(body)) return unknown;
  // A different verification's fields must never change this job's state.
  if (body.verificationId !== undefined
    && (typeof body.verificationId !== 'string' || body.verificationId.toLowerCase() !== verificationId)) return unknown;
  try {
    const state = parseVerification(body, verificationId);
    return { ...state, stateConfirmed: true, stateCheckedAt: new Date().toISOString(),
      terminal: state.currentStep === 'error' || state.errorIds.length > 0 };
  } catch {
    // Some API errors omit the ID/step. Preserve bounded diagnostic codes,
    // but do not promote those responses to a confirmed verification state.
    const errorIds = body.errorIds ?? [];
    const rejectionReasons = body.rejectionReasons ?? [];
    if (!validCodes(errorIds) || !validCodes(rejectionReasons)) return unknown;
    return { ...unknown, responseErrorIds: errorIds, responseRejectionReasons: rejectionReasons,
      terminal: errorIds.length > 0 || body.currentStep === 'error' };
  }
}
