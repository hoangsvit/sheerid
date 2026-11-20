const $ = selector => document.querySelector(selector);
const form = $('#task-form');
const field = name => form.elements.namedItem(name);
let token, selectedId, selectedJob, cursor = 0, selectionVersion = 0, busy = false, connected = false;
let lastActivity = '';
const displayedResults = new Set();
const pendingActions = new Set();
let pollTimer, polling = false, pollRequested = false, queueActive = false, queueLoaded = false;
let connecting;
try { selectedId = sessionStorage.getItem('workbench-selected-job'); } catch { /* storage is optional */ }
const states = { queued: 'Queued', running: 'Running', cancelling: 'Stopping', completed: 'Completed', cancelled: 'Stopped', failed: 'Failed' };

function resultLabel(record) {
  if (record.code === 'CANCELLED' || record.status === 'cancelled') return 'Task stopped';
  if (record.code === 'API_RATE_LIMITED') return 'Too many requests. Please try again later.';
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
    if (record.currentStep === 'pending' || record.event === 'waiting_for_review') return { text: 'Awaiting review' };
    return null;
  }
  const text = {
    web_queued: 'Added to queue', web_started: 'Checking current status', web_cancelling: 'Stopping task', web_resumed: 'Task resumed',
    document_refetch: 'Waiting for document upload', submission_uncertain: 'Awaiting submission confirmation',
    status_query_retry: 'Status query temporarily failed; retrying',
  }[record.event];
  return text ? { text } : null;
}

function setConn(state, text) { const el = $('#connection'); el.dataset.state = state; el.textContent = text; }
function error(message = '') { $('#form-error').textContent = message; $('#form-error').hidden = !message; }
function updateControls() {
  $('#start').textContent = busy ? 'Adding…' : 'Add to queue';
  $('#form-fields').disabled = busy;
  $('#start').disabled = busy;
  $('#cancel').hidden = Boolean(selectedJob?.finishedAt) || selectedJob?.state === 'cancelled';
  $('#cancel').disabled = !connected || !selectedJob || Boolean(selectedJob.finishedAt) || selectedJob.state === 'cancelling' || pendingActions.has(selectedId);
  $('#resume').hidden = selectedJob?.state !== 'cancelled';
  $('#resume').disabled = !connected || !selectedJob?.finishedAt || pendingActions.has(selectedId);
  $('#delete').hidden = !selectedJob?.finishedAt || !['completed', 'failed', 'cancelled'].includes(selectedJob.state);
  $('#delete').disabled = !connected || pendingActions.has(selectedId);
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'X-Local-Token': token ?? '',
    ...(field('password').value ? { 'X-Web-Password': field('password').value } : {}), ...options.headers } });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      connected = false;
      token = undefined;
      field('password').required = true;
      setConn('auth', 'Enter access password');
      updateControls();
    }
    throw Object.assign(new Error(data.error?.message ?? `Request failed (${response.status})`), { status: response.status });
  }
  return data;
}
function render(job, records = []) {
  selectedJob = job;
  $('#selected-job').textContent = job.id;
  $('#job-state').textContent = states[job.state];
  $('#job-state').dataset.state = job.state;
  for (const record of records) {
    if (record.sequence <= cursor) continue;
    cursor = Math.max(cursor, record.sequence);
    if (record.event === 'web_resumed') { lastActivity = ''; displayedResults.clear(); }
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
function selectJob(job) {
  if (selectedId !== job.id) {
    selectionVersion++;
    cursor = 0;
    lastActivity = '';
    displayedResults.clear();
    $('#logs').replaceChildren();
    $('#log-count').textContent = '0 events';
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
    state.textContent = states[job.state] + (job.state === 'queued' ? ` · Position ${job.queuePosition}` : '');
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
        if (selectedId === id && selectionVersion === version) render(data.job, data.events);
      } else render(job);
    }
  } catch (reason) {
    error(reason.status === 401 ? reason.message : `Progress connection lost: ${reason.message}。${queueActive || !queueLoaded ? 'Reconnecting.' : 'Refresh the page and try again.'}`);
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
const FIRST_NAMES = [...new Set(`
  James John Robert Michael William David Richard Joseph Thomas Daniel Matthew Anthony Andrew Joshua Ryan
  Tyler Brandon Kevin Ethan Nathan Christopher Charles Mark Steven Paul Donald George Kenneth Edward Brian
  Ronald Timothy Jason Jeffrey Gary Jacob Nicholas Eric Jonathan Stephen Larry Justin Scott Frank Benjamin
  Gregory Samuel Raymond Patrick Alexander Jack Dennis Jerry Aaron Jose Adam Henry Douglas Zachary Peter
  Kyle Walter Harold Jeremy Carl Keith Roger Gerald Christian Terry Sean Arthur Austin Noah Lawrence
  Jesse Joe Bryan Billy Jordan Albert Dylan Bruce Willie Gabriel Alan Juan Logan Wayne Ralph Roy Eugene
  Randy Vincent Russell Louis Philip Bobby Johnny Bradley Liam Mason Lucas Aiden Caleb Owen Connor Hunter
  Isaac Luke Evan Gavin Chase Cole Blake Wyatt Carter Landon Colin Garrett Trevor Dustin Spencer Marcus
  Mary Jennifer Linda Elizabeth Jessica Sarah Karen Emily Ashley Hannah Olivia Emma Madison Abigail
  Samantha Rachel Lauren Megan Jeannette Grace Patricia Barbara Susan Nancy Lisa Betty Margaret Sandra
  Kimberly Donna Michelle Dorothy Carol Amanda Melissa Deborah Stephanie Rebecca Sharon Laura Cynthia
  Kathleen Amy Angela Shirley Anna Brenda Pamela Nicole Helen Katherine Christine Debra Catherine
  Carolyn Janet Ruth Maria Heather Diane Virginia Julie Joyce Victoria Kelly Christina Joan Evelyn
  Judith Andrea Cheryl Martha Frances Jacqueline Ann Gloria Teresa Kathryn Sara Janice Jean Alice
  Julia Judy Beverly Denise Marilyn Amber Danielle Brittany Diana Natalie Sophia Isabella Ava Mia
  Charlotte Amelia Harper Ella Chloe Lily Zoe Addison Aubrey Brooklyn Savannah Claire Audrey Leah
  Allison Paige Morgan Kayla Taylor Alexis Sydney Haley Courtney Brianna Jasmine Erin Molly Vanessa
  Caroline Natasha Jenna Kendra Monica Erica Tiffany Lindsey Kristen Valerie Bethany Shelby Mackenzie
`.trim().split(/\s+/))];
const LAST_NAMES = [...new Set(`
  Smith Johnson Williams Brown Jones Garcia Miller Davis Wilson Anderson Taylor Thomas Moore Martin
  Jackson Thompson White Harris Clark Lewis Robinson Walker Young Allen King Wright Scott Hill Green
  Adams Baker Nelson Carter Mitchell Roberts Turner Phillips Campbell Parker Conroy Rodriguez Martinez
  Hernandez Lopez Gonzalez Perez Lee Sanchez Ramirez Torres Flores Rivera Gomez Diaz Evans Edwards
  Collins Stewart Morris Rogers Reed Cook Morgan Bell Murphy Bailey Cooper Richardson Cox Howard Ward
  Peterson Gray James Watson Brooks Kelly Sanders Price Bennett Wood Barnes Ross Henderson Coleman
  Jenkins Perry Powell Long Patterson Hughes Washington Butler Simmons Foster Bryant Alexander Russell
  Griffin Hayes Myers Ford Hamilton Graham Sullivan Wallace Woods West Cole Jordan Owens Reynolds
  Fisher Ellis Harrison Gibson McDonald Cruz Marshall Ortiz Gomez Murray Freeman Wells Webb Simpson
  Stevens Tucker Porter Hunter Hicks Crawford Henry Boyd Mason Kennedy Warren Dixon Burns Gordon Shaw
  Holmes Rice Robertson Hunt Black Daniels Palmer Mills Nichols Grant Knight Ferguson Rose Stone
  Hawkins Dunn Perkins Hudson Spencer Gardner Stephens Payne Pierce Berry Matthews Arnold Wagner
  Willis Ray Watkins Olson Carroll Duncan Snyder Hart Cunningham Bradley Lane Andrews Ruiz Harper Fox
  Riley Armstrong Carpenter Weaver Greene Lawrence Elliott Chavez Sims Austin Peters Kelley Franklin
  Lawson Fields Ryan Schmidt Carr Vasquez Castillo Wheeler Chapman Oliver Montgomery Richards
  Williamson Johnston Banks Meyer Bishop McCoy Howell Morrison Hansen Fernandez Harvey Little Burton
  Stanley George Jacobs Reid Fuller Lynch Dean Gilbert Garrett Romero Welch Larson Frazier Burke
  Hanson Day Mendoza Moreno Bowman Medina Fowler Brewer Hoffman Carlson Silva Pearson Holland Douglas
  Fleming Jensen Vargas Byrd Davidson Hopkins May Terry Herrera Wade Soto Walters Curtis Neal Caldwell
`.trim().split(/\s+/))];
const pick = list => list[Math.floor(Math.random() * list.length)];
function randomBirthDate() {
  // Random date for an age of roughly 18–26 years.
  const now = new Date();
  const start = new Date(now.getFullYear() - 26, now.getMonth(), now.getDate()).getTime();
  const end = new Date(now.getFullYear() - 18, now.getMonth(), now.getDate()).getTime();
  const date = new Date(start + Math.random() * (end - start));
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
$('#random-fill').addEventListener('click', () => {
  field('firstName').value = pick(FIRST_NAMES);
  field('lastName').value = pick(LAST_NAMES);
  field('birthDate').value = randomBirthDate();
  updateControls();
});
$('#cancel').addEventListener('click', () => taskAction('cancel'));
$('#resume').addEventListener('click', () => taskAction('resume'));
$('#delete').addEventListener('click', () => taskAction('delete'));
function connect() {
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      const session = await api('/api/session');
      token = session.token;
      connected = true;
      field('password').required = false;
      setConn('ok', 'Service connected');
      error();
      updateControls();
      requestPoll();
      return true;
    } catch (reason) {
      if (reason.status === 401) setConn('auth', 'Enter access password'); else setConn('error', 'Service disconnected');
      if (reason.status !== 401 || field('password').value) error(reason.message);
      return false;
    } finally { connecting = undefined; }
  })();
  return connecting;
}
field('password').addEventListener('change', () => { if (field('password').value) void connect(); });
updateControls();
void connect();
