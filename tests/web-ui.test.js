import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, firefox } from 'playwright-core';
import { listInstalled } from 'camoufox';
import { createWebServer } from '../src/web/server.js';
import { createLogger } from '../src/core/logger.js';
import { webConfig } from './fixtures/web-config.js';
import { AutomationError } from '../src/core/errors.js';
import { runWorkflow } from '../src/core/workflow.js';

const installed = listInstalled().find(item => item.isActive);
const binary = process.platform === 'win32' ? 'camoufox.exe' : process.platform === 'darwin' ? '../MacOS/camoufox' : 'camoufox-bin';
const executablePath = installed && join(installed.path, binary);
const useChromium = process.env.WORKBENCH_TEST_BROWSER === 'chromium';
const browserAvailable = useChromium || (executablePath && existsSync(executablePath));
const launchBrowser = () => useChromium
  ? chromium.launch({ channel: 'chrome', headless: true })
  : firefox.launch({ executablePath, headless: true });

test('Fill saved data uses configured Vietnamese names and birth date without submitting or generating a random identity', {
  skip: browserAvailable ? false : 'No installed browser for local UI fixture', timeout: 30000,
}, async t => {
  const { configFile, raw } = await webConfig(t);
  const profile = { firstName: 'Hoài An', lastName: 'Nguyễn', birthDate: '2001-05-06' };
  Object.assign(raw.data, profile);
  await writeFile(configFile, JSON.stringify(raw));
  let calls = 0;
  const app = createWebServer({ port: 0, configFile, workflow: async () => { calls++; return { status: 'verified' }; } });
  const origin = await app.start();
  t.after(() => app.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const taskUrl = 'https://my.sheerid.com/rest/v2/verification/aaaaaaaaaaaaaaaaaaaaaaaa';
  await page.locator('[name=url]').fill(taskUrl);
  await page.locator('[name=proxy]').fill('127.0.0.1:7777');
  await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Service connected');
  await page.locator('#fill-saved').click();
  await page.waitForFunction(() => document.querySelector('[name=firstName]').value === 'Hoài An');
  for (const [name, expected] of Object.entries(profile)) assert.equal(await page.locator(`[name=${name}]`).inputValue(), expected);
  assert.equal(await page.locator('[name=url]').inputValue(), taskUrl);
  assert.equal(await page.locator('[name=proxy]').inputValue(), '127.0.0.1:7777');
  assert.equal(await page.locator('[name=password]').count(), 0);
  await page.locator('#fill-saved').click();
  await page.waitForFunction(() => !document.querySelector('#fill-saved').disabled);
  assert.equal(await page.locator('[name=firstName]').inputValue(), profile.firstName);
  assert.equal(calls, 0);
  assert.equal(app.jobs.jobs.size, 0);
  delete raw.data.birthDate;
  await writeFile(configFile, JSON.stringify(raw));
  await page.locator('#fill-saved').click();
  await page.waitForFunction(() => document.querySelector('#form-error').textContent.includes('data.birthDate'));
  assert.equal(await page.locator('[name=firstName]').inputValue(), profile.firstName);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});

test('Provider error UI preserves a terminal 429 and marks older state as unconfirmed after a failed check and restart', {
  skip: browserAvailable ? false : 'No installed browser for local UI fixture', timeout: 45000,
}, async t => {
  const { configFile } = await webConfig(t);
  const id = 'ffffffffffffffffffffffff';
  let reads = 0;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://my.sheerid.com/')) {
      assert.equal(String(url), `https://my.sheerid.com/rest/v2/verification/${id}`);
      assert.equal(options.method, 'GET');
      reads++;
      return reads === 1 ? new Response(JSON.stringify({ verificationId: id, currentStep: 'error',
        errorIds: ['docReviewLimitExceeded'], rejectionReasons: ['DOCUMENT_UNREADABLE'], privateEmail: 'never-display@example.edu' }),
      { status: 429 }) : new Response('rate limited', { status: 429 });
    }
    return originalFetch(url, options);
  });
  const workflow = (config, options) => options.statusOnly ? runWorkflow(config, options)
    : Promise.resolve({ status: 'pending', currentStep: 'pending', errorIds: [], rejectionReasons: [],
      stateConfirmed: true, stateCheckedAt: '2026-11-23T09:00:00.000Z' });
  let app = createWebServer({ port: 0, configFile, workflow });
  let origin = await app.start();
  t.after(() => app.close());
  await app.jobs.start({ url: `https://my.sheerid.com/rest/v2/verification/${id}`,
    firstName: 'Private', lastName: 'Student', birthDate: '2000-01-02' });
  await app.jobs.jobs.get(id).done;
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const connect = async () => {
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector('#selected-job').textContent.length > 0);
  };
  await connect();
  assert.match(await page.locator('#verification-state').innerText(), /Last provider response: pending/);
  await page.locator('#check-status').click();
  await page.waitForFunction(() => document.querySelector('#provider-codes').textContent.includes('docReviewLimitExceeded'));
  assert.match(await page.locator('#job-summary').innerText(), /Verification cannot continue/);
  assert.match(await page.locator('#verification-state').innerText(), /Last provider response: error/);
  assert.match(await page.locator('#provider-codes').innerText(), /DOCUMENT_UNREADABLE/);
  assert.equal(app.jobs.get(id).job.result.httpStatus, 429);
  assert.equal(app.jobs.get(id).job.result.stateConfirmed, true);
  app.jobs.jobs.get(id).retryAt = null; // Expire the local cooldown without a provider call.
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#check-status').disabled);
  await page.locator('#check-status').click();
  await page.waitForFunction(() => document.querySelector('#job-summary').textContent.includes('Status unavailable (HTTP 429)'));
  assert.match(await page.locator('#verification-state').innerText(), /Last known: error.*Received/);
  assert.match(await page.locator('#provider-codes').innerText(), /Last confirmed error codes: docReviewLimitExceeded/);
  assert.match(await page.locator('#job-summary').innerText(), /Status unavailable \(HTTP 429\)/);
  assert.equal(reads, 2);
  await app.close();
  app = createWebServer({ port: 0, configFile, workflow });
  origin = await app.start();
  await connect();
  assert.match(await page.locator('#verification-state').innerText(), /unconfirmed.*Last known: error/);
  assert.match(await page.locator('#provider-codes').innerText(), /Last confirmed error codes: docReviewLimitExceeded/);
  assert.doesNotMatch(await page.locator('body').innerText(), /never-display@example.edu/);
  assert.equal(reads, 2, 'restart must not query or submit automatically');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir(resolve('.runs/web-preview'), { recursive: true });
  await page.screenshot({ path: resolve('.runs/web-preview/provider-error-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
});

test('Saved job UI checks a failed verification without resubmitting and restores its request history after restart', {
  skip: browserAvailable ? false : 'No installed browser for local UI fixture', timeout: 30000,
}, async t => {
  const { configFile } = await webConfig(t);
  const calls = [];
  const workflow = async (_config, options) => {
    calls.push(options);
    return options.statusOnly
      ? { status: 'pending', currentStep: 'pending', remoteWriteAttempted: false, uploadAttempt: 0 }
      : { status: 'failed', code: 'API_NETWORK_ERROR' };
  };
  let app = createWebServer({ port: 0, configFile, workflow });
  let origin = await app.start();
  t.after(() => app.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const id = 'eeeeeeeeeeeeeeeeeeeeeeee';
  await app.jobs.start({ url: `https://my.sheerid.com/rest/v2/verification/${id}`,
    firstName: 'Private', lastName: 'Student', birthDate: '2000-01-02' });
  await app.jobs.jobs.get(id).done;
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Failed');
  assert.equal(await page.locator('#check-status').isEnabled(), true);
  await page.locator('#check-status').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Awaiting review');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].submit, false);
  assert.equal(calls[1].statusOnly, true);
  await page.locator('#attempt-history summary').click();
  assert.equal(await page.locator('#attempts li').count(), 2);
  assert.match(await page.locator('#attempts').innerText(), /Verification task.*Network request failed/);
  assert.match(await page.locator('#attempts').innerText(), /Status check.*Awaiting review/);
  await app.close();
  app = createWebServer({ port: 0, configFile, workflow });
  origin = await app.start();
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Awaiting review');
  assert.equal(calls.length, 2, 'restart restores history without executing requests');
  assert.equal(await page.locator('#jobs button').count(), 1);
  assert.equal(await page.locator('#attempts li').count(), 2);
  assert.equal(await page.locator('#resume').isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir(resolve('.runs/web-preview'), { recursive: true });
  await page.screenshot({ path: resolve('.runs/web-preview/saved-history-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
});

test('Web UI deletes failed jobs, allows resubmission and preserves a different selection during deletion', {
  skip: browserAvailable ? false : 'No installed browser for local UI fixture', timeout: 30000,
}, async t => {
  const { configFile } = await webConfig(t);
  let attempts = 0;
  const app = createWebServer({ port: 0, configFile, workflow: async (config, { signal }) => {
    if (config.data.firstName === 'Running') {
      await new Promise(resolveDone => signal.addEventListener('abort', resolveDone, { once: true }));
      return { status: 'cancelled' };
    }
    attempts++;
    throw new AutomationError('API_NETWORK_ERROR', 'API request failed');
  } });
  const origin = await app.start();
  t.after(() => app.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('Service connected'));
  const id = 'dddddddddddddddddddddddd';
  const url = `https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=${id}`;
  await page.locator('[name=url]').fill(url);
  await page.locator('[name=firstName]').fill('NetworkFixture');
  await page.locator('[name=lastName]').fill('Student');
  await page.locator('[name=birthDate]').fill('2000-01-02');
  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Failed');
  assert.equal(await page.locator('#delete').isVisible(), true);
  const path = `${origin}/api/jobs/${id}`;
  await page.route(path, route => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Wait until resource cleanup finishes before deleting' } }) }));
  await page.locator('#delete').click();
  await page.waitForFunction(() => document.querySelector('#form-error').textContent.includes('cleanup'));
  assert.equal(app.jobs.jobs.has(id), true, 'a rejected deletion keeps the task');
  await page.unroute(path);
  await page.locator('#delete').click();
  await page.waitForFunction(() => document.querySelectorAll('#jobs button').length === 0
    && document.querySelector('#job-state').textContent === 'Not started');
  assert.equal(await page.locator('#selected-job').innerText(), '');
  assert.equal(await page.locator('#log-count').innerText(), '0 events');
  assert.equal(await page.locator('#logs .empty').count(), 1);
  assert.equal(await page.locator('#delete').isVisible(), false);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('workbench-selected-job')), null);
  assert.equal(await page.locator('[name=url]').inputValue(), url);
  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Failed');
  assert.equal(attempts, 2, 'the same verification ID runs again after explicit deletion');
  await mkdir(resolve('.runs/web-preview'), { recursive: true });
  await page.screenshot({ path: resolve('.runs/web-preview/delete-failed-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  const runningId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  await app.jobs.start({ url: url.replace(id, runningId), firstName: 'Running', lastName: 'Student', birthDate: '2000-01-02' });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#jobs button').length === 2);
  const deleting = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  await page.route(path, async route => { deleting.resolve(); await release.promise; await route.continue(); });
  await page.locator('#delete').click();
  await deleting.promise;
  assert.equal(await page.locator('#delete').isDisabled(), true);
  await page.locator(`[data-job-id="${runningId}"]`).click();
  release.resolve();
  await page.waitForFunction(() => document.querySelectorAll('#jobs button').length === 1);
  assert.equal(await page.locator('#selected-job').innerText(), runningId);
  assert.equal(await page.locator('#delete').isVisible(), false);
  assert.equal(app.jobs.get(runningId).job.state, 'running');
  await page.locator('#cancel').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Stopped');
  await page.locator('#delete').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Not started');
  assert.equal(app.jobs.jobs.size, 0);
  assert.deepEqual(errors, []);
});

test('Web UI queues multiple IDs, reconnects and stops only the selected task', {
  skip: browserAvailable ? false : 'No installed browser for local UI fixture', timeout: 45000,
}, async t => {
  let received;
  const { configFile } = await webConfig(t);
  const app = createWebServer({ port: 0, configFile, workflow: async (config, { signal }) => {
    received = config;
    const log = createLogger('ui-fixture');
    if (config.data.firstName === 'NetworkFixture') {
      log('stage_started', { stage: 'preflight' });
      log('status_query_retry', { stage: 'preflight', code: 'API_NETWORK_ERROR' });
      log('status_query_retry', { stage: 'preflight', code: 'API_NETWORK_ERROR' });
      throw new AutomationError('API_NETWORK_ERROR', 'API request failed');
    }
    log('stage_started', { stage: 'launch' });
    log('stage_started', { stage: 'wait_ready' });
    log('stage_started', { stage: 'fill' });
    for (let i = 0; i < 100; i++) log('interaction_delay', { stage: 'type', field: 'input' });
    log('field_filled', { stage: 'fill', field: 'email' });
    log('stage_started', { stage: 'submit' });
    log('submit_ready', { stage: 'wait_submit', code: 'BUTTON_CLICKABLE' });
    log('stage_started', { stage: 'document' });
    log('stage_started', { stage: 'read_document' });
    log('stage_started', { stage: 'upload_bytes' });
    log('stage_completed', { stage: 'upload_bytes' });
    log('stage_started', { stage: 'complete_upload' });
    for (let i = 0; i < 3; i++) log('waiting_for_review', { stage: 'wait_review', currentStep: 'pending' });
    const outcome = { status: 'failed', code: 'VERIFICATION_UNAVAILABLE', message: 'Verification cannot continue' };
    log('run_finished', outcome);
    log('run_finished', outcome);
    log('browser_kept_open', { stage: 'await_user_close' });
    await new Promise(resolveDone => signal.addEventListener('abort', resolveDone, { once: true }));
    return outcome;
  } });
  const origin = await app.start();
  t.after(() => app.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1360, height: 1100 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  const reads = [];
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/jobs')) reads.push(request.url());
  });
  async function expectIdle() {
    await page.waitForFunction(() => document.querySelector('#queue-summary').textContent === 'Running 0 / 1 · Queued 0');
    // Allow the final log read to settle, then observe several former poll cycles.
    await page.waitForTimeout(1200);
    const count = reads.length;
    await page.waitForTimeout(2200);
    assert.equal(reads.length, count, 'idle pages must stop automatic requests');
  }
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  assert.equal(app.jobs.jobs.size, 0);
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('Service connected'));
  await page.waitForFunction(() => !document.querySelector('#start').disabled);
  await expectIdle();
  assert.equal(await page.locator('[name=firstName]').inputValue(), '');
  assert.deepEqual(await page.locator('input, select').evaluateAll(items => items.map(item => item.name)), ['url', 'firstName', 'lastName', 'birthDate', 'proxy']);
  const url = 'https://services.sheerid.com/verify/aaaaaaaaaaaaaaaaaaaaaaaa/?verificationId=bbbbbbbbbbbbbbbbbbbbbbbb';
  await page.locator('[name=url]').fill(url);
  await page.locator('[name=firstName]').fill('Test');
  await page.locator('[name=lastName]').fill('Student');
  await page.locator('[name=birthDate]').fill('2000-01-02');
  await page.locator('[name=proxy]').fill('127.0.0.1:8899:user:pass');
  await mkdir(resolve('.runs/web-preview'), { recursive: true });
  await page.screenshot({ path: resolve('.runs/web-preview/desktop.png'), fullPage: true });
  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#logs').textContent.includes('Verification failed'));
  assert.equal(await page.locator('.status-box, #stage, #outcome, #result-detail').count(), 0);
  assert.doesNotMatch(await page.locator('#logs').innerText(), /interaction_delay|field_filled|VERIFICATION_UNAVAILABLE|wait_submit|launching browser|waiting for page readiness|Verification cannot continue/);
  assert.deepEqual(await page.locator('#logs li').evaluateAll(items => items.map(item => item.lastChild.textContent)),
    ['Added to queue', 'Checking current status', 'Preparing information', 'Submitting information', 'Waiting for document upload', 'Document uploaded', 'Awaiting review', 'Verification failed']);
  assert.equal(await page.locator('#logs li').filter({ hasText: 'Verification failed' }).count(), 1);
  const visibleLogCount = await page.locator('#logs li').count();
  assert.ok(visibleLogCount < 10);
  assert.equal(await page.locator('#log-count').innerText(), `${visibleLogCount} events`);
  assert.equal(received.data.organization.optionText, 'Example University');
  assert.equal(received.data.birthDate, '2000-01-02');
  assert.equal(received.data.email, 'test.student@example.edu');
  assert.equal(received.proxy.server, 'http://127.0.0.1:8899');
  assert.equal(await page.locator('[name=url]').isDisabled(), false);
  await page.locator('[name=url]').fill(url.replace('bbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccc'));
  await page.locator('#start').click();
  try {
    await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Queued');
  } catch (error) {
    t.diagnostic(JSON.stringify({ queue: app.jobs.list(), errors,
      ui: await page.locator('#task-form').evaluate(form => ({ valid: form.checkValidity(),
        error: document.querySelector('#form-error').textContent, state: document.querySelector('#job-state').textContent })) }));
    throw error;
  }
  await page.waitForFunction(() => document.querySelectorAll('#jobs button').length === 2);
  await page.screenshot({ path: resolve('.runs/web-preview/desktop.png'), fullPage: true });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Queued');
  await page.locator('#cancel').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Stopped');
  assert.equal(app.jobs.get('bbbbbbbbbbbbbbbbbbbbbbbb').job.state, 'running');
  assert.equal(app.jobs.get('cccccccccccccccccccccccc').job.startedAt, null);
  await page.waitForTimeout(1200);
  const stoppedReads = reads.filter(url => url.includes('/cccccccccccccccccccccccc?')).length;
  const queueReads = reads.filter(url => url.endsWith('/api/jobs')).length;
  await page.waitForTimeout(2200);
  assert.equal(reads.filter(url => url.includes('/cccccccccccccccccccccccc?')).length, stoppedReads);
  assert.ok(reads.filter(url => url.endsWith('/api/jobs')).length > queueReads, 'other active tasks still update');
  await page.locator('#resume').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Queued');
  assert.equal(await page.locator('#resume').isVisible(), false);
  assert.equal(app.jobs.jobs.size, 2);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Queued');
  await page.locator('#cancel').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Stopped');
  assert.equal(await page.locator('#resume').isVisible(), true);
  assert.match(await page.locator('#logs').innerText(), /Task resumed/);
  await page.locator('[data-job-id="bbbbbbbbbbbbbbbbbbbbbbbb"]').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Running');
  await page.locator('#cancel').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Stopped');
  assert.equal(app.jobs.running.size, 0);
  await expectIdle();
  await page.locator('#resume').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Running');
  await page.waitForFunction(() => [...document.querySelectorAll('#logs li')].filter(li => li.textContent.includes('Verification failed')).length === 2);
  await page.locator('#cancel').click();
  await page.waitForFunction(() => document.querySelector('#job-state').textContent === 'Stopped');
  await expectIdle();
  await page.locator('[data-job-id="cccccccccccccccccccccccc"]').click();
  await page.waitForFunction(() => document.querySelector('#logs').textContent.includes('Task resumed'));
  await expectIdle();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve('.runs/web-preview/mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('[type=reset]').click();
  assert.equal(await page.locator('[name=url]').inputValue(), '');
  await page.locator('[name=url]').fill(url.replace('bbbbbbbbbbbbbbbbbbbbbbbb', 'dddddddddddddddddddddddd'));
  await page.locator('[name=firstName]').fill('NetworkFixture');
  await page.locator('[name=lastName]').fill('Student');
  await page.locator('[name=birthDate]').fill('2000-01-02');
  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#logs').textContent.includes('Status query failed. Check the network or proxy.'));
  assert.doesNotMatch(await page.locator('#logs').innerText(), /Verification failed|API_NETWORK_ERROR/);
  assert.equal(await page.locator('#logs li').filter({ hasText: 'Status query temporarily failed; retrying' }).count(), 1);
  await expectIdle();
  assert.deepEqual(errors, []);
});
