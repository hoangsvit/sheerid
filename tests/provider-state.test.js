import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, unlink, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runDocumentWorkflow } from '../src/apps/sheerid/document-workflow.js';
import { runWorkflow } from '../src/core/workflow.js';
import { checkVerificationStatus } from '../src/apps/sheerid/status.js';
import { withLogSink } from '../src/core/logger.js';
import { verificationErrorDetails } from '../src/apps/sheerid/verification-state.js';

const id = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const payload = (currentStep, extra = {}) => ({ verificationId: id, currentStep, errorIds: [], ...extra });
const json = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });

async function fixture(t, replies) {
  const directory = await mkdtemp(join(tmpdir(), 'one-provider-state-'));
  t.after(async () => { for (const name of await readdir(directory)) await unlink(join(directory, name)); await rmdir(directory); });
  const config = { app: 'sheerid', proxy: null, artifactsDir: directory,
    url: `https://services.sheerid.com/verify/bbbbbbbbbbbbbbbbbbbbbbbb/?verificationId=${id}`,
    timeouts: { apiMs: 1000 }, polling: { intervalMs: 1 } };
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, `https://my.sheerid.com/rest/v2/verification/${id}`);
    assert.equal(request.method, 'GET', 'state reads must not submit or upload');
    const reply = replies[reads++];
    assert.ok(reply, 'unexpected extra request');
    return reply;
  });
  return { config, directory, reads: () => reads };
}

test('429 preserves a validated terminal state, diagnostic codes and HTTP status in the result, logs and disk', async t => {
  const { config, directory, reads } = await fixture(t, [json(payload('error', {
    errorIds: ['docReviewLimitExceeded'], rejectionReasons: ['DOCUMENT_UNREADABLE'],
    privateEmail: 'do-not-log@example.edu', uploadUrl: 'https://private.example/signed-secret',
  }), 429, { 'Retry-After': '120' })]);
  const logs = [];
  const result = await withLogSink(record => logs.push(record), () => runDocumentWorkflow(config, { submit: true }));
  assert.equal(reads(), 1, 'a terminal response must not be retried');
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'API_RATE_LIMITED');
  assert.equal(result.httpStatus, 429);
  assert.equal(result.stateConfirmed, true);
  assert.equal(result.currentStep, 'error');
  assert.equal(result.terminal, true);
  assert.deepEqual(result.errorIds, ['docReviewLimitExceeded']);
  assert.deepEqual(result.rejectionReasons, ['DOCUMENT_UNREADABLE']);
  assert.equal(result.retryAfterSeconds, 120);
  assert.ok(Number.isFinite(Date.parse(result.stateCheckedAt)));
  assert.doesNotMatch(result.message, /Wait.*retry|before retrying/);
  assert.equal(result.uploadAttempt, 0);
  const finished = logs.find(record => record.event === 'run_finished');
  for (const key of ['httpStatus', 'stateConfirmed', 'stateCheckedAt', 'terminal', 'retryAfterSeconds']) {
    assert.equal(finished[key], result[key]);
  }
  const saved = await readFile(join(directory, `${result.runId}.json`), 'utf8');
  assert.deepEqual(JSON.parse(saved), JSON.parse(JSON.stringify(result)));
  assert.doesNotMatch(saved + JSON.stringify(logs), /do-not-log|private.example|signed-secret/);
});

test('An opaque 429 leaves the current state unconfirmed and timestamps the older pending response', async t => {
  const { config, reads } = await fixture(t, [json(payload('pending')), new Response('<html>rate limit</html>', { status: 429 })]);
  const result = await withLogSink(() => {}, () => runDocumentWorkflow(config, { submit: true }));
  assert.equal(reads(), 2);
  assert.equal(result.httpStatus, 429);
  assert.equal(result.stateConfirmed, false);
  assert.equal(result.currentStep, undefined);
  assert.equal(result.lastKnownStep, 'pending');
  assert.ok(Number.isFinite(Date.parse(result.lastKnownAt)));
  assert.equal(result.stateCheckedAt, undefined);
  assert.equal(result.submissionAttempted, false);
});

test('A validated terminal error supersedes pending while preserving it as older context', async t => {
  const { config, reads } = await fixture(t, [json(payload('pending')), json(payload('error', {
    errorIds: ['verificationLimitExceeded'], rejectionReasons: ['DOCUMENT_EXPIRED'],
  }), 429)]);
  const result = await withLogSink(() => {}, () => runDocumentWorkflow(config, { submit: true }));
  assert.equal(reads(), 2);
  assert.equal(result.currentStep, 'error');
  assert.equal(result.stateConfirmed, true);
  assert.equal(result.lastKnownStep, 'pending');
  assert.ok(result.lastKnownAt);
  assert.deepEqual(result.errorIds, ['verificationLimitExceeded']);
});

test('Initial routing and browser preflight preserve provider failure details without opening a browser', async t => {
  for (const branch of ['routing', 'browser']) await t.test(branch, async t => {
    const { config, reads } = await fixture(t, [json(payload('error', {
      errorIds: ['verificationLimitExceeded'], rejectionReasons: ['DOCUMENT_EXPIRED'],
    }), 403)]);
    const operation = branch === 'routing' ? () => runWorkflow(config, { submit: true })
      : () => checkVerificationStatus({ config });
    await assert.rejects(withLogSink(() => {}, operation), error => {
      assert.equal(error.httpStatus, 403);
      assert.equal(error.stateConfirmed, true);
      assert.equal(error.currentStep, 'error');
      assert.deepEqual(error.errorIds, ['verificationLimitExceeded']);
      assert.deepEqual(error.rejectionReasons, ['DOCUMENT_EXPIRED']);
      return true;
    });
    assert.equal(reads(), 1);
  });
});

test('Missing identity preserves only bounded API diagnostics; mismatched identity never confirms another job', async t => {
  for (const body of [payload('error', { verificationId: 'bbbbbbbbbbbbbbbbbbbbbbbb', errorIds: ['WrongJob'] }),
    { verificationId: id, currentStep: 'error', errorIds: ['invalid code with spaces'] },
    { currentStep: 'error', errorIds: ['x'.repeat(101)] }]) {
    const details = verificationErrorDetails(body, id);
    assert.equal(details.stateConfirmed, false);
    assert.equal(details.currentStep, undefined);
    assert.equal(details.errorIds, undefined);
    assert.equal(details.responseErrorIds, undefined);
  }
  const { config, reads } = await fixture(t, [json({ errorIds: ['verificationLimitExceeded'] }, 429, { 'Retry-After': '0' })]);
  const result = await withLogSink(() => {}, () => runDocumentWorkflow(config, { submit: true }));
  assert.equal(reads(), 1);
  assert.equal(result.stateConfirmed, false);
  assert.equal(result.currentStep, undefined);
  assert.deepEqual(result.responseErrorIds, ['verificationLimitExceeded']);
  assert.doesNotMatch(result.message, /Wait.*retry|before retrying/);
});

test('Document completion preserves a terminal HTTP error without replaying the upload or hiding it behind more reads', async t => {
  for (const httpStatus of [429, 503]) await t.test(String(httpStatus), async t => {
    const { config } = await fixture(t, []);
    config.document = { url: 'http://localhost/original.png' };
    config.timeouts.downloadMs = config.timeouts.uploadMs = 1000;
    const methods = [];
    t.mock.method(globalThis, 'fetch', async (url, request = {}) => {
      const method = request.method ?? 'GET';
      methods.push(method);
      if (String(url) === config.document.url) return new Response(Buffer.from('89504e470d0a1a0a', 'hex'));
      if (method === 'GET') return json(payload('docUpload'));
      if (method === 'PUT') return new Response(null);
      if (String(url).endsWith('/step/docUpload')) return json(payload('docUpload', {
        documents: [{ uploadUrl: 'https://test.s3.amazonaws.com/proof' }],
      }));
      assert.ok(String(url).endsWith('/step/completeDocUpload'));
      return json(payload('error', { errorIds: ['docReviewLimitExceeded'], rejectionReasons: ['DOCUMENT_UNREADABLE'] }), httpStatus);
    });
    const result = await withLogSink(() => {}, () => runDocumentWorkflow(config, { submit: true }));
    assert.equal(result.httpStatus, httpStatus);
    assert.equal(result.stateConfirmed, true);
    assert.equal(result.currentStep, 'error');
    assert.deepEqual(result.errorIds, ['docReviewLimitExceeded']);
    assert.deepEqual(result.rejectionReasons, ['DOCUMENT_UNREADABLE']);
    assert.equal(result.submissionUncertain, false);
    assert.equal(result.uploadAttempt, 1);
    assert.deepEqual(methods, ['GET', 'GET', 'POST', 'PUT', 'POST']);
  });
});

test('Terminal provider states on 5xx are not retried as transient transport errors', async t => {
  const { config, reads } = await fixture(t, [json(payload('error', { errorIds: ['verificationLimitExceeded'] }), 503)]);
  await assert.rejects(withLogSink(() => {}, () => runWorkflow(config, { submit: true })),
    { httpStatus: 503, terminal: true, stateConfirmed: true });
  assert.equal(reads(), 1);
});

test('CLI preflight error output retains validated provider codes without logging the response body', async t => {
  const { config, directory } = await fixture(t, []);
  const configFile = join(directory, 'cli-config.json');
  const mockFile = join(directory, 'fetch-fixture.mjs');
  await writeFile(configFile, JSON.stringify({ app: 'sheerid', proxy: 'direct', url: config.url, artifactsDir: directory }));
  await writeFile(mockFile, `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(payload('error', {
    errorIds: ['docReviewLimitExceeded'], rejectionReasons: ['DOCUMENT_UNREADABLE'], privateEmail: 'do-not-log@example.edu',
  })))}, {status:429});`);
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', pathToFileURL(mockFile).href, resolve('src/cli.js'), '--config', configFile, '--submit'], {
    windowsHide: true, timeout: 10000, env: { ...process.env, AUTOMATION_URL: config.url, AUTOMATION_PROXY: 'direct' },
  }), error => {
    assert.equal(error.code, 1);
    const result = JSON.parse(error.stderr.trim().split(/\r?\n/).at(-1));
    assert.equal(result.stateConfirmed, true);
    assert.equal(result.currentStep, 'error');
    assert.equal(result.httpStatus, 429);
    assert.deepEqual(result.errorIds, ['docReviewLimitExceeded']);
    assert.doesNotMatch(error.stderr, /do-not-log/);
    return true;
  });
});
