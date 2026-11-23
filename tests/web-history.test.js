import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebJobs } from '../src/web/jobs.js';
import { createWebServer } from '../src/web/server.js';
import { AutomationError } from '../src/core/errors.js';
import { webConfig } from './fixtures/web-config.js';
import { verificationErrorDetails } from '../src/apps/sheerid/verification-state.js';

const id = 'abababababababababababab';
const input = { url: `https://my.sheerid.com/rest/v2/verification/${id}`,
  firstName: 'PrivateFirst', lastName: 'PrivateLast', birthDate: '1999-10-12', proxy: '127.0.0.1:8888:proxy-user:proxy-secret' };

async function fixture(t, workflow) {
  const { configFile, raw } = await webConfig(t);
  const instances = [];
  const open = async (nextWorkflow = workflow) => {
    const jobs = new WebJobs({ configFile, workflow: nextWorkflow });
    instances.push(jobs);
    await jobs.initialize();
    return jobs;
  };
  t.after(async () => { for (const jobs of instances) await jobs.close(); });
  return { open, configFile, filename: join(raw.artifactsDir, 'web-jobs.json') };
}

test('Finished jobs, results and duplicate protection survive restart without persisting identity or proxy secrets', async t => {
  let calls = 0;
  const { open, filename } = await fixture(t, async () => { calls++; return { status: 'failed', code: 'API_NETWORK_ERROR' }; });
  const jobs = await open();
  await jobs.start(input);
  await jobs.jobs.get(id).done;
  const original = jobs.get(id);
  await jobs.close();
  const disk = await readFile(filename, 'utf8');
  assert.doesNotMatch(disk, /PrivateFirst|PrivateLast|1999-10-12|proxy-user|proxy-secret|saved-secret|config"|https:/);
  const restored = await open();
  assert.deepEqual(restored.get(id), original);
  assert.equal(restored.get(id).job.canResume, false);
  assert.equal(restored.get(id).attempts.length, 1);
  assert.equal((await restored.start(input)).state, 'failed');
  assert.equal(calls, 1, 'restoring or selecting a duplicate must not execute a workflow');
  restored.remove(id);
  await restored.close();
  assert.equal((await open()).list().jobs.length, 0, 'deletion must survive restart');
});

test('Failed restored jobs can check status once, keep previous request results and never submit', async t => {
  const { open } = await fixture(t, async () => ({ status: 'failed', code: 'API_NETWORK_ERROR', uploadAttempt: 3 }));
  const jobs = await open();
  await jobs.start(input);
  await jobs.jobs.get(id).done;
  await jobs.close();
  const gate = Promise.withResolvers();
  let calls = 0;
  const restored = await open(async (config, options) => {
    calls++;
    assert.equal(options.submit, false);
    assert.equal(options.statusOnly, true);
    assert.equal(options.resumeUncertainStage, undefined);
    assert.equal(config.url, input.url);
    assert.equal(config.proxy, null, 'restored status checks use direct connections');
    await gate.promise;
    return { status: 'pending', currentStep: 'pending', remoteWriteAttempted: false, uploadAttempt: 0 };
  });
  await Promise.all([restored.checkStatus(id), restored.checkStatus(id.toUpperCase())]);
  assert.equal(calls, 1);
  gate.resolve();
  await restored.jobs.get(id).done;
  const detail = restored.get(id);
  assert.equal(detail.job.result.status, 'pending');
  assert.equal(detail.job.operation, 'status');
  assert.ok(detail.job.lastCheckedAt);
  assert.equal(detail.attempts.length, 2);
  assert.equal(detail.attempts[0].result.uploadAttempt, 3);
  assert.equal(detail.attempts[1].operation, 'status');
  assert.equal(detail.attempts[1].result.remoteWriteAttempted, false);
  await restored.close();
  assert.deepEqual((await open()).get(id), detail);
});

test('Interrupted jobs restore idle, preserve activity and cannot resume a submission after restart', async t => {
  const { open, filename } = await fixture(t, async () => ({ status: 'pending' }));
  const jobs = await open();
  await jobs.start(input);
  await jobs.jobs.get(id).done;
  await jobs.close();
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  Object.assign(saved.jobs[0], { state: 'running', finishedAt: null, result: null });
  saved.jobs[0].attempts = [];
  await writeFile(filename, JSON.stringify(saved));
  let calls = 0;
  const restored = await open(async () => { calls++; return { status: 'verified' }; });
  const detail = restored.get(id);
  assert.equal(calls, 0);
  assert.equal(restored.list().running, 0);
  assert.equal(restored.list().queued, 0);
  assert.equal(detail.job.state, 'cancelled');
  assert.equal(detail.job.result.code, 'SERVICE_INTERRUPTED');
  assert.equal(detail.job.canResume, false);
  assert.ok(detail.events.some(event => event.event === 'web_recovered'));
  assert.throws(() => restored.resume(id), { code: 'JOB_NOT_RESUMABLE' });
});

test('Rate-limit cooldown survives restart and a check is never automatically retried', async t => {
  const { open } = await fixture(t, async () => ({ status: 'failed', code: 'API_RATE_LIMITED', retryAfterSeconds: 120 }));
  const jobs = await open();
  await jobs.start(input);
  await jobs.jobs.get(id).done;
  const retryAt = jobs.get(id).job.retryAt;
  assert.ok(Date.parse(retryAt) >= Date.now() + 110000);
  await assert.rejects(jobs.checkStatus(id), { code: 'STATUS_COOLDOWN' });
  await jobs.close();
  let calls = 0;
  const restored = await open(async () => { calls++; return { status: 'verified' }; });
  assert.equal(restored.get(id).job.retryAt, retryAt);
  await assert.rejects(restored.checkStatus(id), { code: 'STATUS_COOLDOWN' });
  assert.equal(calls, 0);
});

test('Provider responses remain distinct from task failures and keep their confirmation time across checks and restart', async t => {
  const confirmedAt = '2026-11-23T09:00:00.000Z';
  let calls = 0;
  const { open } = await fixture(t, async (_config, options) => {
    if (calls++ === 0) return { status: 'pending', currentStep: 'pending', errorIds: [], rejectionReasons: [],
      stateConfirmed: true, stateCheckedAt: confirmedAt };
    assert.equal(options.statusOnly, true);
    assert.equal(options.submit, false);
    const error = new AutomationError('API_RATE_LIMITED', 'HTTP 429');
    Object.assign(error, { httpStatus: 429, stateConfirmed: false });
    if (calls === 2) Object.assign(error, verificationErrorDetails({ verificationId: id, currentStep: 'error',
      errorIds: ['docReviewLimitExceeded'], rejectionReasons: ['DOCUMENT_UNREADABLE'], privateEmail: 'do-not-log@example.edu' }, id));
    throw error;
  });
  const jobs = await open();
  await jobs.start(input);
  await jobs.jobs.get(id).done;
  assert.equal(jobs.get(id).job.providerState.currentStep, 'pending');
  await jobs.checkStatus(id);
  await jobs.jobs.get(id).done;
  const terminal = jobs.get(id).job;
  assert.equal(terminal.state, 'failed');
  assert.equal(terminal.result.httpStatus, 429);
  assert.equal(terminal.result.stateConfirmed, true);
  assert.equal(terminal.result.currentStep, 'error');
  assert.deepEqual(terminal.result.errorIds, ['docReviewLimitExceeded']);
  assert.equal(terminal.providerState.currentStep, 'error');
  jobs.jobs.get(id).retryAt = null; // Simulate expiration of the local cooldown.
  await jobs.checkStatus(id);
  await jobs.jobs.get(id).done;
  const stale = jobs.get(id).job;
  assert.equal(stale.result.stateConfirmed, false);
  assert.equal(stale.result.currentStep, undefined);
  assert.equal(stale.result.lastKnownStep, 'error');
  assert.equal(stale.result.lastKnownAt, terminal.providerState.stateCheckedAt);
  assert.deepEqual(stale.providerState, terminal.providerState);
  assert.equal(jobs.get(id).attempts[0].result.stateCheckedAt, confirmedAt);
  assert.doesNotMatch(JSON.stringify(jobs.get(id)), /do-not-log/);
  await jobs.close();
  const restored = await open();
  assert.deepEqual(restored.get(id).job.providerState, terminal.providerState);
  assert.deepEqual(restored.get(id).job.result, stale.result);
  assert.equal(calls, 3);
});

test('Invalid history is not overwritten and only one writer owns a history file', async t => {
  const { open, filename, configFile } = await fixture(t, async () => ({ status: 'verified' }));
  const first = await open();
  const second = new WebJobs({ configFile });
  await assert.rejects(second.initialize(), { code: 'STORAGE_ERROR' });
  await first.close();
  await writeFile(filename, '{invalid JSON');
  await assert.rejects(open(), { code: 'STORAGE_ERROR' });
  assert.equal(await readFile(filename, 'utf8'), '{invalid JSON');
});

test('Storage failure rejects admission before calling the external workflow', async t => {
  let calls = 0;
  const { open } = await fixture(t, async () => { calls++; return { status: 'verified' }; });
  const jobs = await open();
  jobs.store.write = () => { throw new AutomationError('STORAGE_ERROR', 'Disk unavailable'); };
  await assert.rejects(jobs.start(input), { code: 'STORAGE_ERROR' });
  assert.equal(calls, 0);
  assert.equal(jobs.jobs.size, 0);
});

test('Status-check endpoint needs only the automatic request token and exposes request history', async t => {
  const { configFile } = await webConfig(t);
  const calls = [];
  const app = createWebServer({ port: 0, configFile, workflow: async (_config, options) => {
    calls.push(options);
    return { status: options.statusOnly ? 'pending' : 'failed', code: options.statusOnly ? 'VERIFICATION_STATE' : 'API_NETWORK_ERROR' };
  } });
  const origin = await app.start();
  t.after(() => app.close());
  await app.jobs.start(input);
  await app.jobs.jobs.get(id).done;
  const path = `${origin}/api/jobs/${id}/check-status`;
  const { token } = await (await fetch(`${origin}/api/session`)).json();
  assert.equal((await fetch(path, { method: 'POST' })).status, 403);
  const response = await fetch(path, { method: 'POST', headers: { 'X-Local-Token': token } });
  assert.equal(response.status, 202);
  await app.jobs.jobs.get(id).done;
  const detail = await (await fetch(`${origin}/api/jobs/${id}`)).json();
  assert.equal(detail.attempts.length, 2);
  assert.equal(detail.job.result.status, 'pending');
  assert.equal(calls[1].submit, false);
  assert.equal(calls[1].statusOnly, true);
});
