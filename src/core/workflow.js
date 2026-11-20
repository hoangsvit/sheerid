import { AutomationError, requireValue } from './errors.js';
import { createVerificationClient } from '../apps/sheerid/client.js';
import { runDocumentWorkflow } from '../apps/sheerid/document-workflow.js';
import { withNetwork } from './network.js';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
import { queryStatusWithRetry } from './status-query.js';

// Select an executor from the current server state. Each executor rechecks under its task lock
// before making changes, so routing never bypasses the existing preflight or error handling.
export function runWorkflow(config, options = {}) {
  return withNetwork(config, () => executeWorkflow(config, options));
}

async function executeWorkflow(config, { submit = false, statusOnly = false, file, url: documentUrl, signal, resumeUncertainStage } = {}) {
  requireValue(config.app === 'sheerid', 'Automatic routing currently supports only sheerid');
  requireValue(!(statusOnly && submit), '--status and --submit cannot be used together');
  requireValue(!(file !== undefined && documentUrl !== undefined), 'Specify either --file or --url, not both');
  if (statusOnly) return runDocumentWorkflow(config, { signal });
  signal?.throwIfAborted();
  if (resumeUncertainStage) return runDocumentWorkflow(config, {
    submit, file, url: documentUrl, signal, resumeUncertainStage,
  });
  const log = createLogger(randomUUID());
  log('stage_started', { stage: 'preflight' });
  const client = createVerificationClient(config, signal);
  const { state } = await queryStatusWithRetry(() => client.getStatus(), {
    signal, intervalMs: config.polling?.intervalMs, log,
  });
  log('verification_status', { stage: 'preflight', ...state });
  if (state.currentStep === 'collectStudentPersonalInfo' && state.errorIds.length === 0) {
    requireValue(config.browser.autoFill !== false || !submit,
      'Autofill is disabled. Enter data manually in the browser; use --submit for evidence when the document stage is reached');
    const url = new URL(config.url);
    if (url.origin !== 'https://services.sheerid.com' || !/^\/verify\/[a-f\d]{24}\/?$/i.test(url.pathname)) {
      throw new AutomationError('FORM_URL_REQUIRED', 'The form must be filled. Set url to the full SheerID verification page URL containing verificationId');
    }
    // Load Camoufox only for the browser branch; status/material-only runs stay browser-free.
    const { runAutomation } = await import('./runner.js');
    return runAutomation(config, {
      submit, signal,
      afterSubmit: submit
        ? ({ uncertainSubmission = false, beforeDocumentUpload } = {}) => runDocumentWorkflow(config, {
          submit: true, file, url: documentUrl, signal, uncertainSubmission, beforeDocumentUpload,
        })
        : undefined,
    });
  }
  return runDocumentWorkflow(config, { submit, file, url: documentUrl, signal });
}
