const $ = selector => document.querySelector(selector);
const form = $('#task-form');
const field = name => form.elements.namedItem(name);
let token, selectedId, selectedJob, cursor = 0, selectionVersion = 0, busy = false, connected = false;
let lastActivity = '';
const displayedResults = new Set();
const pendingActions = new Set();
let pollTimer, polling = false, pollRequested = false, queueActive = false, queueLoaded = false;
let connecting, cooldownTimer, fillingSaved = false;
try { selectedId = sessionStorage.getItem('workbench-selected-job'); } catch { /* storage is optional */ }
const states = { queued: 'Queued', running: 'Running', cancelling: 'Stopping', completed: 'Completed', cancelled: 'Stopped', failed: 'Failed' };

function resultLabel(record) {
  if (record.code === 'CANCELLED' || record.status === 'cancelled') return 'Task stopped';
  if (record.code === 'SERVICE_INTERRUPTED') return 'Service interrupted. Check current status.';
  if (record.stateConfirmed && (record.currentStep === 'error' || record.errorIds?.length)) return 'Verification cannot continue (provider response)';
  if (record.code === 'API_RATE_LIMITED') return 'Status unavailable (HTTP 429)';
  if (['PROXY_START_FAILED', 'PROXY_UNAVAILABLE', 'INVALID_PROXY', 'INVALID_SYSTEM_PROXY'].includes(record.code)) return 'Proxy connection failed. Check your proxy settings.';
  const stage = record.documentStage ?? record.stage;
  const querying = ['starting', 'preflight', 'query_status'].includes(stage);
  if (['API_NETWORK_ERROR', 'API_TIMEOUT', 'STATUS_REQUEST_FAILED', 'STATUS_REQUEST_TIMEOUT'].includes(record.code)) {
    return querying ? 'Status query failed. Check the network or proxy.'
      : stage === 'upload_bytes' ? 'File upload failed. Check the network or proxy.' : 'Network request failed. Check the network or proxy.';
  }
  if (['API_HTTP_ERROR', 'STATUS_HTTP_ERROR', 'API_RESPONSE_INVALID', 'STATUS_RESPONSE_INVALID'].includes(record.code)) {
    return querying ? 'Status query failed. Please retry later.' : 'API request failed. Please retry later.';
  }
  if (record.status === 'failed') {
    return record.currentStep === 'error' || record.errorIds?.length
      || ['VERIFICATION_UNAVAILABLE', 'HTTP_CLIENT_ERROR', 'SERVER_VALIDATION_ERROR'].includes(record.code)
      ? 'Verification failed' : 'Task execution failed';
  }
  return ({ verified: 'Verification successful', rejected: 'Verification failed', filled: 'Information entered', manual: 'Waiting for manual input',
    pending: 'Awaiting review', submission_unknown: 'Awaiting submission confirmation' })[record.status] ?? 'Task completed';
}

// Display milestones, not keystrokes. The API cursor still consumes every event.
function activity(record) {
  if (['run_finished', 'web_finished'].includes(record.event)) {
    const label = resultLabel(record);
    return { text: label, resultKey: label };
  }
  if (record.event === 'stage_started') {
    const text = { launch: 'Preparing information', fill: 'Preparing information', submit: 'Submitting information',
      document: 'Waiting for document upload', read_document: 'Waiting for document upload', cancel_sso: 'Waiting for document upload',
      initiate_upload: 'Waiting for document upload', upload_bytes: 'Waiting for document upload' }[record.stage];
    return text ? { text } : null;
  }
  if (record.event === 'stage_completed' && record.stage === 'upload_bytes') return { text: 'Document uploaded' };
  if (['waiting_for_review', 'verification_status'].includes(record.event)) {
    if (record.code === 'AWAITING_WRITE_CONFIRMATION') return { text: 'Awaiting submission confirmation' };
    if (record.currentStep === 'emailLoop') return { text: 'Waiting for email verification' };
    if (record.currentStep === 'pending') return { text: 'Awaiting review' };
    if (record.event === 'waiting_for_review') return { text: ({ docUpload: 'Additional documents requested',
      sso: 'School sign-in required', collectStudentPersonalInfo: 'Waiting for server confirmation' })[record.currentStep] ?? 'Waiting for provider status' };
    return null;
  }
  const text = {
    web_queued: 'Added to queue', web_started: 'Checking current status', web_cancelling: 'Stopping task', web_resumed: 'Task resumed',
    web_status_check: 'Status check requested', web_recovered: 'Restored after service interruption; check current status',
    document_refetch: 'Waiting for document upload', submission_uncertain: 'Awaiting submission confirmation',
    status_query_retry: 'Status query temporarily failed; retrying',
  }[record.event];
  return text ? { text } : null;
}

function setConn(state, text) { const el = $('#connection'); el.dataset.state = state; el.textContent = text; }
function error(message = '') { $('#form-error').textContent = message; $('#form-error').hidden = !message; }
function updateControls() {
  $('#start').textContent = busy ? 'Adding…' : 'Add to queue';
  $('#form-fields').disabled = busy || fillingSaved;
  $('#start').disabled = busy || fillingSaved;
  $('#fill-saved').disabled = busy || fillingSaved;
  $('#fill-saved').textContent = fillingSaved ? 'Filling…' : 'Fill saved data';
  $('#cancel').hidden = Boolean(selectedJob?.finishedAt) || selectedJob?.state === 'cancelled';
  $('#cancel').disabled = !connected || !selectedJob || Boolean(selectedJob.finishedAt) || selectedJob.state === 'cancelling' || pendingActions.has(selectedId);
  $('#resume').hidden = !selectedJob?.canResume;
  $('#resume').disabled = !connected || !selectedJob?.finishedAt || pendingActions.has(selectedId);
  $('#delete').hidden = !selectedJob?.finishedAt || !['completed', 'failed', 'cancelled'].includes(selectedJob.state);
  $('#delete').disabled = !connected || pendingActions.has(selectedId);
  const checking = selectedJob?.operation === 'status' && !selectedJob?.finishedAt;
  const remaining = Math.max(0, Date.parse(selectedJob?.retryAt) - Date.now()) || 0;
  $('#check-status').hidden = !selectedJob?.finishedAt && !checking;
  $('#check-status').disabled = !connected || !selectedJob?.finishedAt || pendingActions.has(selectedId) || remaining > 0;
  $('#check-status').textContent = checking ? 'Checking status…' : remaining > 0
    ? `Check status in ${Math.ceil(remaining / 1000)}s` : 'Check status';
  clearTimeout(cooldownTimer);
  if (remaining > 0) cooldownTimer = setTimeout(updateControls, Math.min(remaining, 1000));
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'X-Local-Token': token ?? '',
    ...options.headers } });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data.error?.message ?? `Request failed (${response.status})`), { status: response.status });
  }
  return data;
}
function render(job, records = []) {
  selectedJob = job;
  $('#selected-job').textContent = job.id;
  $('#job-state').textContent = job.state === 'completed' && job.result ? resultLabel(job.result) : states[job.state];
  $('#job-state').dataset.state = job.state;
  $('#job-summary').textContent = [
    job.result ? resultLabel(job.result) : job.operation === 'status' ? 'Reading current status' : '',
    job.createdAt ? `Created ${new Date(job.createdAt).toLocaleString()}` : '',
    job.lastCheckedAt ? `Last check attempted ${new Date(job.lastCheckedAt).toLocaleString()}` : '',
  ].filter(Boolean).join(' · ');
  renderProviderState(job);
  for (const record of records) {
    if (record.sequence <= cursor) continue;
    cursor = Math.max(cursor, record.sequence);
    if (['web_resumed', 'web_status_check'].includes(record.event)) { lastActivity = ''; displayedResults.clear(); }
    const entry = activity(record);
    if (!entry || entry.text === lastActivity || (entry.resultKey && displayedResults.has(entry.resultKey))) continue;
    lastActivity = entry.text;
    if (entry.resultKey) displayedResults.add(entry.resultKey);
    $('#logs .empty')?.remove();
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date(record.time).toLocaleTimeString();
    item.append(time, entry.text);
    $('#logs').append(item);
    if ($('#logs').children.length > 200) $('#logs').firstElementChild.remove();
  }
  $('#log-count').textContent = `${$('#logs').querySelectorAll('li:not(.empty)').length} events`;
  if (records.length) $('#logs').scrollTop = $('#logs').scrollHeight;
  updateControls();
}

function renderProviderState(job) {
  const result = job.result ?? {};
  const confirmed = result.stateConfirmed === true && result.currentStep;
  const source = confirmed ? result : job.providerState;
  const step = source?.currentStep ?? result.lastKnownStep;
  const checkedAt = source?.stateCheckedAt ?? result.lastKnownAt;
  const time = checkedAt ? ` · Received ${new Date(checkedAt).toLocaleString()}` : '';
  $('#verification-state').textContent = confirmed ? `Last provider response: ${step}${time}`
    : step ? `Current verification state is unconfirmed. Last known: ${step}${time}`
      : 'Current verification state is unconfirmed. No validated provider response is available.';
  const codes = [
    source?.errorIds?.length ? `${confirmed ? 'Provider' : 'Last confirmed'} error codes: ${source.errorIds.join(', ')}` : '',
    source?.rejectionReasons?.length ? `${confirmed ? 'Provider' : 'Last confirmed'} rejection reasons: ${source.rejectionReasons.join(', ')}` : '',
    result.responseErrorIds?.length ? `API response codes (state unconfirmed): ${result.responseErrorIds.join(', ')}` : '',
    result.responseRejectionReasons?.length ? `API response reasons (state unconfirmed): ${result.responseRejectionReasons.join(', ')}` : '',
  ].filter(Boolean).join(' · ');
  $('#provider-codes').textContent = codes;
  $('#provider-codes').hidden = !codes;
}

function renderAttempts(attempts = []) {
  $('#attempts').replaceChildren();
  for (const attempt of attempts) {
    const item = document.createElement('li');
    item.textContent = `${new Date(attempt.finishedAt).toLocaleString()} · ${attempt.operation === 'status' ? 'Status check' : 'Verification task'} · ${resultLabel(attempt.result ?? {})}`;
    $('#attempts').append(item);
  }
  $('#attempt-history summary').textContent = `Request history (${attempts.length})`;
}
function selectJob(job) {
  if (selectedId !== job.id) {
    selectionVersion++;
    cursor = 0;
    lastActivity = '';
    displayedResults.clear();
    $('#logs').replaceChildren();
    $('#log-count').textContent = '0 events';
    renderAttempts();
  }
  selectedId = job.id;
  try { sessionStorage.setItem('workbench-selected-job', selectedId); } catch { /* optional */ }
  render(job);
}

function clearSelection() {
  selectionVersion++;
  selectedId = selectedJob = undefined;
  cursor = 0;
  lastActivity = '';
  displayedResults.clear();
  try { sessionStorage.removeItem('workbench-selected-job'); } catch { /* optional */ }
  $('#selected-job').textContent = '';
  $('#job-summary').textContent = '';
  $('#verification-state').textContent = '';
  $('#provider-codes').textContent = '';
  $('#provider-codes').hidden = true;
  renderAttempts();
  $('#job-state').textContent = 'Not started';
  delete $('#job-state').dataset.state;
  $('#log-count').textContent = '0 events';
  const empty = document.createElement('li');
  empty.className = 'empty';
  empty.textContent = 'Task progress will appear here after it starts.';
  $('#logs').replaceChildren(empty);
  updateControls();
}

function renderQueue(queue) {
  $('#queue-summary').textContent = `Running ${queue.running} / ${queue.concurrency} · Queued ${queue.queued}`;
  $('#jobs').replaceChildren();
  for (const job of queue.jobs) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.jobId = job.id;
    button.setAttribute('aria-pressed', String(job.id === selectedId));
    const id = document.createElement('span');
    id.textContent = job.id;
    const state = document.createElement('span');
    state.textContent = (job.finishedAt && job.result ? resultLabel(job.result) : states[job.state])
      + (job.state === 'queued' ? ` · Position ${job.queuePosition}` : '');
    button.append(id, state);
    button.addEventListener('click', () => { selectJob(job); renderQueue(queue); requestPoll(); });
    item.append(button);
    $('#jobs').append(item);
  }
}

function requestPoll() {
  clearTimeout(pollTimer);
  if (polling) { pollRequested = true; return; }
  void poll();
}
async function poll() {
  if (polling || !connected) return;
  polling = true;
  pollRequested = false;
  try {
    const requestedVersion = selectionVersion;
    const queue = await api('/api/jobs');
    if (queue.storageError) error(queue.storageError);
    if (selectionVersion !== requestedVersion) return;
    queueLoaded = true;
    queueActive = queue.jobs.some(job => !job.finishedAt);
    if (!selectedId || !queue.jobs.some(job => job.id === selectedId)) {
      const next = queue.jobs.find(job => !job.finishedAt) ?? queue.jobs.at(-1);
      if (next) selectJob(next);
      else if (selectedId) clearSelection();
    }
    renderQueue(queue);
    const id = selectedId;
    const version = selectionVersion;
    const job = queue.jobs.find(job => job.id === id);
    if (job) {
      // Finished tasks only need a final read for logs that have not been shown.
      if (!job.finishedAt || job.lastSequence > cursor) {
        const data = await api(`/api/jobs/${id}?after=${cursor}`);
        if (selectedId === id && selectionVersion === version) {
          render(data.job, data.events);
          renderAttempts(data.attempts);
        }
      } else render(job);
    }
  } catch (reason) {
    error(`Progress connection lost: ${reason.message}。${queueActive || !queueLoaded ? 'Reconnecting.' : 'Refresh the page and try again.'}`);
  } finally {
    polling = false;
    // Keep a single timer while there is work; an idle page sends no requests.
    if (connected && (pollRequested || queueActive || !queueLoaded)) {
      pollTimer = setTimeout(poll, pollRequested ? 0 : 1000);
    }
  }
}
form.addEventListener('change', updateControls);
form.addEventListener('reset', () => { error(); setTimeout(updateControls, 0); });
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  error();
  const value = name => field(name).value.trim();
  const input = Object.fromEntries(['url', 'firstName', 'lastName', 'birthDate', 'proxy'].map(name => [name, value(name)]));
  busy = true;
  updateControls();
  try {
    if (!connected && !await connect()) return;
    const { job } = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    selectJob(job);
  } catch (reason) { error(reason.message); }
  finally { busy = false; updateControls(); requestPoll(); }
});
async function taskAction(action) {
  const id = selectedId;
  if (!id || pendingActions.has(id)) return;
  pendingActions.add(id);
  selectionVersion++;
  error();
  updateControls();
  try {
    if (action === 'delete') {
      await api(`/api/jobs/${id}`, { method: 'DELETE' });
      selectionVersion++;
      if (selectedId === id) clearSelection();
    } else {
      const { job } = await api(`/api/jobs/${id}/${action}`, { method: 'POST' });
      if (selectedId === id) { selectionVersion++; render(job); }
    }
  } catch (reason) { error(reason.message); }
  finally { pendingActions.delete(id); updateControls(); requestPoll(); }
}
$('#fill-saved').addEventListener('click', async () => {
  if (busy || fillingSaved) return;
  fillingSaved = true;
  error();
  updateControls();
  try {
    if (!connected && !await connect()) return;
    const profile = await api('/api/form-defaults');
    for (const name of ['firstName', 'lastName', 'birthDate']) field(name).value = profile[name];
  } catch (reason) { error(reason.message); }
  finally { fillingSaved = false; updateControls(); }
});
$('#cancel').addEventListener('click', () => taskAction('cancel'));
$('#resume').addEventListener('click', () => taskAction('resume'));
$('#delete').addEventListener('click', () => taskAction('delete'));
$('#check-status').addEventListener('click', () => taskAction('check-status'));
function connect() {
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      const session = await api('/api/session');
      token = session.token;
      connected = true;
      setConn('ok', 'Service connected');
      error();
      updateControls();
      requestPoll();
      return true;
    } catch (reason) {
      connected = false;
      token = undefined;
      setConn('error', 'Service disconnected');
      error(reason.message);
      updateControls();
      return false;
    } finally { connecting = undefined; }
  })();
  return connecting;
}
updateControls();
void connect();
