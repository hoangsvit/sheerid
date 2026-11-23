import { AutomationError } from '../../core/errors.js';
import { isRecord } from '../../core/config.js';
import { networkFetch } from '../../core/network.js';
import { readResponseError } from '../../core/http.js';
import { verificationErrorDetails } from './verification-state.js';
import { queryStatusWithRetry } from '../../core/status-query.js';

export const stepStatuses = Object.freeze({
  success: 'verified',
  docUpload: 'document_required',
  sso: 'sso_required',
  emailLoop: 'email_required',
  pending: 'pending',
  error: 'rejected',
  collectStudentPersonalInfo: 'validation_failed',
});

// Only this step is handled by the personal-information form adapter.
export function checkVerificationStatus(context) {
  return queryStatusWithRetry(() => readVerificationStatus(context), {
    signal: context.signal, intervalMs: context.config.polling?.intervalMs, log: context.log,
  });
}

async function readVerificationStatus({ config, signal }) {
  const verificationId = new URL(config.url).searchParams.get('verificationId')?.toLowerCase();
  if (!verificationId || !/^[a-f\d]{24}$/.test(verificationId)) {
    throw new AutomationError('INVALID_CONFIG', 'Status check requires a valid verificationId');
  }
  const timeoutSignal = AbortSignal.timeout(config.timeouts.apiMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let body;
  try {
    const response = await networkFetch(`https://my.sheerid.com/rest/v2/verification/${verificationId}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: requestSignal,
    });
    if (!response.ok) {
      throw await readResponseError(response, {
        code: 'STATUS_HTTP_ERROR', message: `Status endpoint returned HTTP ${response.status}; browser was not launched`,
        parseErrorBody: body => verificationErrorDetails(body, verificationId),
      });
    }
    try {
      body = await response.json();
    } catch (cause) {
      if (requestSignal.aborted) throw cause;
      throw new AutomationError('STATUS_RESPONSE_INVALID', 'Status endpoint did not return valid JSON; browser was not launched', { cause });
    }
  } catch (cause) {
    if (signal?.aborted) throw new AutomationError('CANCELLED', 'Status check cancelled', { cause });
    if (timeoutSignal.aborted) {
      throw new AutomationError('STATUS_REQUEST_TIMEOUT', 'Status endpoint timed out; browser was not launched', { cause });
    }
    if (cause instanceof AutomationError) throw cause;
    throw new AutomationError('STATUS_REQUEST_FAILED', 'Cannot read status endpoint; browser was not launched', { cause });
  }
  const errorIds = body?.errorIds ?? [];
  const rejectionReasons = body?.rejectionReasons ?? [];
  // Keep only bounded status codes; never log the full response or verification ID.
  if (!isRecord(body) || typeof body.verificationId !== 'string'
    || body.verificationId.toLowerCase() !== verificationId
    || typeof body.currentStep !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(body.currentStep)
    || !Array.isArray(errorIds) || errorIds.length > 50
    || !errorIds.every(code => typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(code))
    || !Array.isArray(rejectionReasons) || rejectionReasons.length > 50
    || !rejectionReasons.every(code => typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(code))) {
    throw new AutomationError('STATUS_RESPONSE_INVALID', 'Invalid status endpoint fields or mismatched verification ID; browser was not launched');
  }
  const { currentStep } = body;
  const details = { currentStep, errorIds, rejectionReasons, stateConfirmed: true, stateCheckedAt: new Date().toISOString() };
  if (currentStep === 'collectStudentPersonalInfo' && errorIds.length === 0) {
    return { proceed: true, ...details };
  }
  const status = errorIds.length > 0 ? 'rejected'
    : Object.hasOwn(stepStatuses, currentStep) ? stepStatuses[currentStep] : 'not_actionable';
  const messages = {
    verified: 'The provider confirmed verification; no form entry required; browser was not launched',
    document_required: 'Additional documents are required; initial form entry is not needed; browser was not launched',
    sso_required: 'School login verification is required; browser was not launched',
    email_required: 'Email verification is required; browser was not launched',
    pending: 'Review is currently pending; browser was not launched',
    rejected: 'Verification is in an error or rejected state; browser was not launched; follow the instructions on the SheerID page',
    not_actionable: 'The current step is not a supported student-information form; browser was not launched',
  };
  return {
    proceed: false,
    outcome: { status, ...details, code: 'PREFLIGHT_NO_FORM', message: messages[status] },
  };
}
