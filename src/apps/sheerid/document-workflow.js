import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AutomationError, requireValue } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { withTaskLock, saveResult } from '../../core/storage.js';
import { createVerificationClient, validateUploadUrl } from './client.js';
import { readDocument, selectDocumentSource } from './document.js';
import { withNetwork } from '../../core/network.js';
import { responseDetails } from '../../core/response-details.js';

function describe(state) {
  const statuses = {
    success: ['verified', 'Verification succeeded'], pending: ['pending', 'Documents are awaiting review'],
    docUpload: ['document_required', 'Evidence upload is required'], sso: ['sso_required', 'School sign-in or document review is required'],
    emailLoop: ['email_required', 'Email verification is required'],
    collectStudentPersonalInfo: ['personal_info_required', 'Student information is still required'],
    error: ['rejected', 'Verification rejected or an error occurred; workflow stopped'],
  };
  const [status, message] = state.errorIds.length ? statuses.error
    : Object.hasOwn(statuses, state.currentStep) ? statuses[state.currentStep] : ['not_actionable', 'Current step is outside the document-upload workflow'];
  return { status, message, ...state, code: 'VERIFICATION_STATE' };
}

export function runDocumentWorkflow(config, options = {}) {
  return withNetwork(config, () => executeDocumentWorkflow(config, options));
}

async function executeDocumentWorkflow(config, options) {
  const { file, url, signal } = options;
  requireValue(config.app === 'sheerid', 'HTTP-only evidence workflow currently supports only sheerid');
  requireValue(!(file !== undefined && url !== undefined), 'Specify either --file or --url, not both');
  const client = createVerificationClient(config, signal);
  return withTaskLock(config.artifactsDir, `sheerid:${client.verificationId}`,
    () => executeLockedDocumentWorkflow(config, options, client));
}

async function executeLockedDocumentWorkflow(config, { submit = false, file, url, signal, uncertainSubmission = false, resumeUncertainStage, beforeDocumentUpload }, client) {
  const runId = randomUUID();
  const log = createLogger(runId);
  const started = Date.now();
  const intervalMs = config.polling?.intervalMs ?? 5000;
  let stage = 'query_status', state, result;
  let remoteWriteAttempted = false, submissionAttempted = false, inFlight = false;
  let uploadAttempt = 0;
  let uncertainStage = resumeUncertainStage || (uncertainSubmission ? 'personal_info' : null);
  const envelope = outcome => ({
    runId, app: config.app, mode: submit ? 'api_submit' : 'api_status', browserOpened: false,
    startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started, stage, remoteWriteAttempted, submissionAttempted, uploadAttempt, ...outcome,
  });
  const wait = async milliseconds => {
    // Chunk long Retry-After delays to avoid the JS timer limit; every wait is cancellable.
    for (let remaining = milliseconds; remaining > 0; remaining -= Math.min(remaining, 60000)) {
      await delay(Math.min(remaining, 60000), undefined, { signal });
    }
    signal?.throwIfAborted();
  };
  const query = async () => {
    let failures = 0;
    while (true) {
      signal?.throwIfAborted();
      stage = 'query_status';
      try {
        const response = await client.getStatus();
        log('verification_status', { stage, ...response.state });
        return response.state;
      } catch (error) {
        const transient = ['API_NETWORK_ERROR', 'API_TIMEOUT'].includes(error.code) || (error.httpStatus >= 500 && error.httpStatus < 600)
          || (error.httpStatus === 429 && error.retryAfterSeconds !== undefined && !error.terminal);
        if (!submit || signal?.aborted || error.terminal || !transient) throw error;
        const delayMs = Math.max(Math.min(intervalMs * 2 ** Math.min(failures++, 6), 60000), (error.retryAfterSeconds ?? 0) * 1000);
        stage = 'wait_review';
        log('status_query_retry', { stage, code: error.code, delayMs });
        await wait(delayMs);
      }
    }
  };
  const write = async (nextStage, operation) => {
    signal?.throwIfAborted();
    stage = nextStage;
    remoteWriteAttempted = true;
    if (stage === 'complete_upload') submissionAttempted = true;
    await saveResult(config.artifactsDir, envelope({ status: 'submission_unknown', code: 'REMOTE_OPERATION_STARTED' }));
    log('stage_started', { stage, uploadAttempt });
    inFlight = true;
    const response = await operation();
    inFlight = false;
    log('stage_completed', { stage, uploadAttempt });
    return response;
  };
  const upload = async () => {
    // Only a confirmed API document step releases the browser for handoff.
    if (state.currentStep === 'docUpload') await beforeDocumentUpload?.();
    stage = 'read_document';
    uploadAttempt++;
    log(uploadAttempt > 1 || state.rejectionReasons.length ? 'document_refetch' : 'stage_started', {
      stage, uploadAttempt, rejectionReasons: state.rejectionReasons,
    });
    // Each server-requested upload rereads the original source. Never retain
    // bytes or a signed upload URL from a previous review round.
    const document = await readDocument(selectDocumentSource(config.document, { file, url }, config.data), {
      signal, timeoutMs: config.timeouts.downloadMs,
    });
    if (state.currentStep === 'sso') {
      ({ state } = await write('cancel_sso', () => client.cancelSso()));
      log('verification_status', { stage, ...state });
      if (state.errorIds.length || state.currentStep !== 'docUpload') return;
      await beforeDocumentUpload?.();
    }
    const initiated = await write('initiate_upload', () => client.initiateUpload([{
      fileName: document.fileName, mimeType: document.mimeType, fileSize: document.fileSize,
    }]));
    state = initiated.state;
    if (state.errorIds.length || state.currentStep !== 'docUpload') return;
    const documents = initiated.body.documents;
    if (!Array.isArray(documents) || documents.length !== 1 || !documents[0]
      || (documents[0].errors != null && (!Array.isArray(documents[0].errors) || documents[0].errors.length))) {
      throw new AutomationError('UPLOAD_NOT_ALLOCATED', 'API did not return a single uploadable document record; no upload attempted');
    }
    if ((documents[0].mimeType != null && documents[0].mimeType !== document.mimeType)
      || (documents[0].fileSize != null && documents[0].fileSize !== document.fileSize)) {
      throw new AutomationError('UPLOAD_METADATA_MISMATCH', 'Server document metadata does not match the file type or size; no upload attempted');
    }
    const uploadUrl = validateUploadUrl(documents[0].uploadUrl);
    await write('upload_bytes', () => client.upload(uploadUrl, document));
    ({ state } = await write('complete_upload', () => client.completeUpload()));
  };
  try {
    log('run_started', { app: config.app, stage, mode: submit ? 'api_submit' : 'api_status' });
    state = await query();
    if (!submit) { result = envelope(describe(state)); return result; }
    while (true) {
      signal?.throwIfAborted();
      if (state.currentStep === 'success' && !state.errorIds.length) {
        result = envelope(describe(state)); break;
      }
      if (state.currentStep === 'error' || state.errorIds.length) {
        result = envelope({ ...describe(state), status: 'failed' }); break;
      }
      // A read confirming progress resolves an ambiguous earlier write. If the
      // server remains at its old step, only poll: do not repeat that write.
      if (state.currentStep === 'pending' || state.currentStep === 'emailLoop'
        || (uncertainStage === 'personal_info' && ['sso', 'docUpload'].includes(state.currentStep))
        || (uncertainStage === 'cancel_sso' && state.currentStep === 'docUpload')) uncertainStage = null;
      if (['sso', 'docUpload'].includes(state.currentStep) && !uncertainStage) {
        try { await upload(); }
        catch (error) {
          if (error.stateConfirmed && error.terminal) { inFlight = false; throw error; }
          const knownRejection = error.httpStatus >= 400 && error.httpStatus < 500;
          if (knownRejection) inFlight = false;
          if (!inFlight || knownRejection || signal?.aborted) throw error;
          uncertainStage = stage;
          inFlight = false;
          log('submission_uncertain', { stage, status: 'submission_unknown', code: error.code });
        }
        if (state.currentStep === 'success' || state.currentStep === 'error' || state.errorIds.length) continue;
      } else if (!['pending', 'emailLoop', 'sso', 'docUpload'].includes(state.currentStep)
        && !(uncertainStage === 'personal_info' && state.currentStep === 'collectStudentPersonalInfo')) {
        result = envelope({ status: 'failed', code: 'UNSUPPORTED_VERIFICATION_STEP', ...state,
          message: 'The document workflow cannot continue from the current stage; follow the verification page instructions' }); break;
      }
      stage = 'wait_review';
      log('waiting_for_review', { stage, ...state, uploadAttempt,
        code: uncertainStage ? 'AWAITING_WRITE_CONFIRMATION' : state.currentStep === 'emailLoop' ? 'AWAITING_EMAIL' : 'AWAITING_REVIEW',
        delayMs: intervalMs });
      await wait(intervalMs);
      state = await query();
    }
  } catch (error) {
    result = envelope({ status: 'failed',
      code: signal?.aborted ? 'CANCELLED' : error instanceof AutomationError ? error.code : 'DOCUMENT_WORKFLOW_ERROR',
      message: signal?.aborted ? 'Task stopped; the server determines the final outcome of any submitted operation'
        : error instanceof AutomationError ? error.message : 'Document API workflow failed; operation stopped',
      stateConfirmed: false, lastKnownStep: state?.currentStep, lastKnownAt: state?.stateCheckedAt,
      ...responseDetails(error), submissionUncertain: Boolean(uncertainStage || inFlight),
      uncertainStage: uncertainStage || (inFlight ? stage : undefined),
    });
  } finally {
    if (result) { await saveResult(config.artifactsDir, result); log('run_finished', result); }
  }
  return result;
}
