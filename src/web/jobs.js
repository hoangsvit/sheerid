import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normalizeConfig, normalizeWebConfig, checkKeys } from '../core/config.js';
import { AutomationError, requireValue } from '../core/errors.js';
import { withLogSink } from '../core/logger.js';
import { runWorkflow } from '../core/workflow.js';
import { verificationIdFromUrl } from '../apps/sheerid/client.js';
import { JobStore } from './job-store.js';
import { responseDetails } from '../core/response-details.js';

export class WebJobs {
  constructor({ configFile = resolve('config/sheerid.local.json'), workflow = runWorkflow } = {}) {
    this.configFile = configFile;
    this.workflow = workflow;
    this.jobs = new Map();
    this.queue = [];
    this.running = new Set();
    this.concurrency = 1;
    this.admissions = Promise.resolve();
    this.closing = false;
    this.draining = false;
    this.storageError = null;
  }

  async readConfig() {
    try { return JSON.parse((await readFile(this.configFile, 'utf8')).replace(/^\uFEFF/, '')); }
    catch { throw new AutomationError('INVALID_CONFIG', 'Configuration file cannot be read or is not valid JSON'); }
  }

  async initialize() {
    if (this.store) return;
    const raw = await this.readConfig();
    this.concurrency = normalizeWebConfig(raw?.web).concurrency;
    const store = new JobStore(resolve(raw.artifactsDir ?? '.runs', 'web-jobs.json'));
    try {
      store.open();
      const saved = store.read();
      // Validate everything before changing or writing the existing history.
      const ids = new Set();
      for (const job of saved) {
        if (!job || !/^[a-f\d]{24}$/.test(job.id) || ids.has(job.id)
          || !['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled'].includes(job.state)
          || !['submit', 'manual'].includes(job.mode) || !Array.isArray(job.events)
          || !Array.isArray(job.attempts) || !Number.isSafeInteger(job.sequence) || job.sequence < 0) {
          throw new AutomationError('STORAGE_ERROR', 'Saved job history contains an invalid task; history was not overwritten');
        }
        ids.add(job.id);
      }
      for (const savedJob of saved) {
        const job = { ...savedJob, providerState: savedJob.providerState ?? null,
          controller: new AbortController(), done: Promise.resolve(), resolveDone: () => {} };
        this.rememberProviderState(job, job.result);
        // Recovery is deliberately idle: a previous process may have submitted
        // remotely before it stopped. Only an explicit status check is allowed.
        if (!job.finishedAt || ['queued', 'running', 'cancelling'].includes(job.state)) {
          job.state = 'cancelled';
          job.finishedAt = new Date().toISOString();
          job.result = { status: job.operation === 'status' ? 'failed' : 'submission_unknown', code: 'SERVICE_INTERRUPTED',
            stateConfirmed: false,
            submissionUncertain: job.operation !== 'status',
            message: 'Service stopped before this task finished. Check the current status before taking further action.',
            lastKnownStep: job.providerState?.currentStep ?? job.result?.currentStep ?? job.result?.lastKnownStep,
            lastKnownAt: job.providerState?.stateCheckedAt ?? job.result?.lastKnownAt };
          job.attempts.push({ operation: job.operation ?? 'submit', startedAt: job.startedAt,
            finishedAt: job.finishedAt, result: job.result });
          job.events.push({ event: 'web_recovered', time: job.finishedAt, sequence: ++job.sequence });
          job.events = job.events.slice(-400);
        }
        this.jobs.set(job.id, job);
      }
      this.store = store;
      this.persist();
    } catch (error) {
      store.close();
      this.store = null;
      this.jobs.clear();
      throw error;
    }
  }

  persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.store?.write([...this.jobs.values()].map(job => ({
      id: job.id, mode: job.mode, operation: job.operation, state: job.state, stage: job.stage,
      createdAt: job.createdAt, queuedAt: job.queuedAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      result: job.result, sequence: job.sequence, events: job.events, attempts: job.attempts,
      lastCheckedAt: job.lastCheckedAt, retryAt: job.retryAt,
      providerState: job.providerState,
    })));
  }

  assertStorage() {
    if (this.storageError) throw this.storageError;
  }

  rememberProviderState(job, result) {
    if (result?.stateConfirmed === true && result.currentStep) {
      job.providerState = { currentStep: result.currentStep, errorIds: result.errorIds ?? [],
        rejectionReasons: result.rejectionReasons ?? [], stateCheckedAt: result.stateCheckedAt ?? null };
    }
  }

  saveProgress(immediate = false) {
    const save = () => {
      try { this.persist(); }
      catch (error) {
        this.storageError = error;
        for (const id of this.running) this.jobs.get(id).controller.abort();
      }
    };
    if (immediate) save();
    else if (!this.persistTimer) this.persistTimer = setTimeout(save, 100).unref();
  }

  start(input) {
    // Serialize admission only, not execution: preserve FIFO and deduplicate even
    // when concurrent HTTP requests are awaiting disk reads or validation.
    const admission = this.admissions.then(() => this.enqueue(input));
    this.admissions = admission.catch(() => {});
    return admission;
  }

  async enqueue(input) {
    if (this.closing) throw new AutomationError('SERVER_STOPPING', 'Service is shutting down');
    this.assertStorage();
    checkKeys(input, ['url', 'firstName', 'lastName', 'birthDate', 'proxy'], 'form');
    for (const key of ['url', 'firstName', 'lastName',  'birthDate']) {
      requireValue(typeof input[key] === 'string' && input[key].trim().length > 0, `Provide ${key}`);
    }

    requireValue(input.proxy === undefined || typeof input.proxy === 'string', 'Proxy must be a string');
    let id;
    try { id = verificationIdFromUrl(input.url.trim()); }
    catch (error) {
      if (error instanceof AutomationError) throw error;
      throw new AutomationError('INVALID_CONFIG', 'Invalid verification URL');
    }
    // Completed/cancelled IDs also remain unique until explicitly deleted.
    // Repeated clicks must never silently repeat an external submission.
    const existing = this.jobs.get(id);
    if (existing) return this.snapshot(existing);
    const raw = await this.readConfig();
    const domain = (
      raw.data?.organization?.emailDomain ||
      raw.emailDomain ||
      raw.data?.emailDomain ||
      ''
    ).trim().replace(/^@+/, '');
    requireValue(domain.length > 0, 'organization.emailDomain is missing in the configuration');
    const first = input.firstName.trim().toLowerCase().replace(/\s+/g, '');
    const last = input.lastName.trim().toLowerCase().replace(/\s+/g, '');
    const email = `${first}.${last}@${domain}`;
    const config = await normalizeConfig({
      ...raw, url: input.url.trim(), proxy: input.proxy?.trim() || 'direct',
      data: { ...raw?.data, firstName: input.firstName.trim(), lastName: input.lastName.trim(), email, birthDate: input.birthDate.trim() },
    }, {});
    if (this.closing) throw new AutomationError('SERVER_STOPPING', 'Service is shutting down');
    this.concurrency = config.web.concurrency;
    const { promise: done, resolve: resolveDone } = Promise.withResolvers();
    const job = {
      id, mode: config.browser.autoFill ? 'submit' : 'manual', state: 'queued', stage: 'queued',
      queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null, result: null,
      sequence: 0, events: [], attempts: [], operation: 'submit',
      providerState: null,
      controller: new AbortController(), config, statusProxy: config.proxy, done, resolveDone,
    };
    job.createdAt = job.queuedAt;
    this.jobs.set(id, job);
    this.queue.push(id);
    this.record(job, { event: 'web_queued', stage: 'queued', mode: job.mode });
    if (this.storageError) {
      this.jobs.delete(id);
      this.queue = this.queue.filter(queuedId => queuedId !== id);
      throw this.storageError;
    }
    this.drain();
    return this.snapshot(job);
  }

  drain() {
    if (this.closing || this.draining || this.storageError) return;
    this.draining = true;
    try {
      while (this.running.size < this.concurrency && this.queue.length) {
        const job = this.jobs.get(this.queue.shift());
        if (job.state !== 'queued') continue;
        job.state = 'running';
        job.startedAt = new Date().toISOString();
        this.running.add(job.id);
        this.record(job, { event: 'web_started', stage: 'starting', mode: job.mode });
        if (this.storageError) {
          job.state = 'failed';
          job.result = { status: 'failed', code: 'STORAGE_ERROR', message: this.storageError.message };
          this.finish(job);
          break;
        }
        const config = job.config;
        void this.execute(job, config);
      }
    } finally { this.draining = false; }
  }

  record(job, record) {
    const event = { ...record, time: record.time ?? new Date().toISOString(), sequence: ++job.sequence };
    job.events.push(event);
    if (job.events.length > 400) job.events.shift();
    if (record.stage) job.stage = record.stage;
    this.rememberProviderState(job, record);
    if (record.event === 'run_finished') job.result = publicResult(record);
    // Save admission and lifecycle boundaries before returning or executing.
    // Coalesce keystroke/activity events to avoid blocking the queue on each log.
    this.saveProgress(record.event.startsWith('web_') || record.event === 'run_finished');
  }

  async execute(job, config) {
    try {
      const result = await withLogSink(record => this.record(job, record), () => this.workflow(config, {
        submit: job.operation !== 'status' && job.mode === 'submit', statusOnly: job.operation === 'status',
        signal: job.controller.signal, resumeUncertainStage: job.operation === 'status' ? undefined : job.resumeUncertainStage,
      }));
      job.result = publicResult(result);
      job.state = job.controller.signal.aborted ? 'cancelled'
        : ['failed', 'rejected', 'validation_failed'].includes(job.result.status) ? 'failed' : 'completed';
    } catch (error) {
      job.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.result = job.result?.status === 'submission_unknown' ? job.result : {
        status: 'failed', code: job.controller.signal.aborted ? 'CANCELLED'
          : error instanceof AutomationError ? error.code : 'WEB_WORKFLOW_ERROR',
        message: error instanceof AutomationError ? error.message : 'Task failed. Check the activity log.',
        stage: error.stage ?? job.stage,
        stateConfirmed: false, ...responseDetails(error),
        ...(job.resumeUncertainStage ? { submissionUncertain: true, uncertainStage: job.resumeUncertainStage } : {}),
      };
    } finally {
      // Workflow resolution includes browser/proxy cleanup. Only then release
      // the slot, including when cancellation occurs while launching a browser.
      this.finish(job);
    }
  }

  finish(job) {
    job.finishedAt = new Date().toISOString();
    this.rememberProviderState(job, job.result);
    if (job.result?.stateConfirmed !== true && job.providerState) {
      job.result = { ...job.result, stateConfirmed: false,
        lastKnownStep: job.result.lastKnownStep ?? job.providerState.currentStep,
        lastKnownAt: job.result.lastKnownAt ?? job.providerState.stateCheckedAt };
    }
    if (job.operation === 'status') job.lastCheckedAt = job.finishedAt;
    job.attempts.push({ operation: job.operation, startedAt: job.startedAt, finishedAt: job.finishedAt, result: job.result });
    job.retryAt = job.result?.code === 'API_RATE_LIMITED'
      ? new Date(Math.min(8640000000000000,
        Date.now() + Math.max(60000, (job.result.retryAfterSeconds ?? 0) * 1000))).toISOString() : null;
    // Stopped jobs retain their original settings for an explicit resume.
    if (job.state !== 'cancelled' || job.operation === 'status') delete job.config;
    this.record(job, { event: 'web_finished', ...job.result });
    this.running.delete(job.id);
    job.resolveDone();
    this.drain();
  }

  snapshot(job) {
    return { id: job.id, verificationId: job.id, mode: job.mode, state: job.state, stage: job.stage,
      queuePosition: job.state === 'queued' ? this.queue.indexOf(job.id) + 1 : null,
      queuedAt: job.queuedAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      createdAt: job.createdAt, operation: job.operation, attemptCount: job.attempts.length,
      canResume: job.state === 'cancelled' && Boolean(job.config) && job.operation !== 'status',
      lastCheckedAt: job.lastCheckedAt ?? null, retryAt: job.retryAt ?? null,
      providerState: job.providerState,
      result: job.result, lastSequence: job.sequence };
  }

  list() {
    return { concurrency: this.concurrency, running: this.running.size, queued: this.queue.length,
      storageError: this.storageError?.message ?? null,
      jobs: [...this.jobs.values()].map(job => this.snapshot(job)) };
  }

  get(id, after = 0) {
    const job = this.jobs.get(id.toLowerCase());
    if (!job) throw new AutomationError('JOB_NOT_FOUND', 'Task not found or expired');
    return { job: this.snapshot(job), events: job.events.filter(event => event.sequence > after), attempts: job.attempts };
  }

  cancel(id) {
    const job = this.jobs.get(id.toLowerCase());
    if (!job) throw new AutomationError('JOB_NOT_FOUND', 'Task not found or expired');
    if (job.state === 'queued') {
      this.queue = this.queue.filter(queuedId => queuedId !== job.id);
      job.controller.abort();
      job.state = 'cancelled';
      job.stage = 'cancelled';
      job.result = { status: 'cancelled', code: 'CANCELLED', message: 'Queued task cancelled before execution',
        ...(job.resumeUncertainStage ? { submissionUncertain: true, uncertainStage: job.resumeUncertainStage } : {}) };
      this.finish(job);
    } else if (job.state === 'running') {
      job.state = 'cancelling';
      this.record(job, { event: 'web_cancelling', code: 'CANCELLED' });
      job.controller.abort();
    }
    return this.snapshot(job);
  }

  resume(id) {
    if (this.closing) throw new AutomationError('SERVER_STOPPING', 'Service is shutting down');
    this.assertStorage();
    const job = this.jobs.get(id.toLowerCase());
    if (!job) throw new AutomationError('JOB_NOT_FOUND', 'Task not found or expired');
    // Repeated clicks are idempotent. Cleanup must finish before a fresh run.
    if (['queued', 'running'].includes(job.state)) return this.snapshot(job);
    if (job.state !== 'cancelled' || !job.finishedAt || !job.config || job.operation === 'status') {
      throw new AutomationError('JOB_NOT_RESUMABLE', 'Only stopped tasks with completed cleanup can be resumed');
    }
    const { promise: done, resolve: resolveDone } = Promise.withResolvers();
    job.resumeUncertainStage = job.result?.uncertainStage
      || (job.result?.submissionUncertain || job.result?.status === 'submission_unknown'
        ? (job.result?.documentStage || (job.result?.browserOpened === false ? 'complete_upload' : 'personal_info')) : undefined);
    Object.assign(job, { state: 'queued', stage: 'queued', queuedAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, result: null, controller: new AbortController(), done, resolveDone });
    this.queue.push(job.id);
    this.record(job, { event: 'web_resumed', stage: 'queued', mode: job.mode });
    this.assertStorage();
    this.drain();
    return this.snapshot(job);
  }

  remove(id) {
    if (this.closing) throw new AutomationError('SERVER_STOPPING', 'Service is shutting down');
    this.assertStorage();
    const job = this.jobs.get(id.toLowerCase());
    if (!job) throw new AutomationError('JOB_NOT_FOUND', 'Task not found or expired');
    if (!job.finishedAt || !['completed', 'failed', 'cancelled'].includes(job.state)
      || this.running.has(job.id) || this.queue.includes(job.id)) {
      throw new AutomationError('JOB_ACTIVE', 'Stop the task and wait for cleanup before deleting it');
    }
    this.jobs.delete(job.id);
    try { this.persist(); }
    catch (error) { this.jobs.set(job.id, job); throw error; }
    return { id: job.id, deleted: true };
  }

  async close() {
    this.closing = true;
    await this.admissions;
    for (const job of this.jobs.values()) if (!job.finishedAt) this.cancel(job.id);
    await Promise.all([...this.jobs.values()].map(job => job.done));
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.store?.close();
  }

  checkStatus(id) {
    const admission = this.admissions.then(async () => {
      if (this.closing) throw new AutomationError('SERVER_STOPPING', 'Service is shutting down');
      this.assertStorage();
      const job = this.jobs.get(id.toLowerCase());
      if (!job) throw new AutomationError('JOB_NOT_FOUND', 'Task not found or expired');
      if (job.operation === 'status' && ['queued', 'running'].includes(job.state)) return this.snapshot(job);
      if (!job.finishedAt || this.running.has(job.id)) throw new AutomationError('JOB_ACTIVE', 'Wait for task cleanup before checking status');
      if (Date.parse(job.retryAt) > Date.now()) throw new AutomationError('STATUS_COOLDOWN', `Wait until ${job.retryAt} before checking again`);
      const raw = await this.readConfig();
      const config = await normalizeConfig({ ...raw,
        url: `https://my.sheerid.com/rest/v2/verification/${job.id}`, proxy: 'direct',
      }, {});
      // Retain a custom proxy only in this process; secrets are never saved.
      config.proxy = job.statusProxy ?? null;
      if (this.closing) throw new AutomationError('SERVER_STOPPING', 'Service is shutting down');
      const { promise: done, resolve: resolveDone } = Promise.withResolvers();
      Object.assign(job, { operation: 'status', state: 'queued', stage: 'queued',
        queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null, result: null,
        controller: new AbortController(), config, done, resolveDone });
      this.queue.push(job.id);
      this.record(job, { event: 'web_status_check', stage: 'queued' });
      this.assertStorage();
      this.drain();
      return this.snapshot(job);
    });
    this.admissions = admission.catch(() => {});
    return admission;
  }
}

function publicResult(result = {}) {
  const keys = ['status', 'code', 'message', 'stage', 'runId', 'currentStep', 'errorIds',
    'durationMs', 'browserOpened', 'submissionAttempted', 'remoteWriteAttempted',
    'lastKnownStep', 'documentRunId', 'documentStage', 'uploadAttempt', 'rejectionReasons', 'submissionUncertain', 'uncertainStage', 'retryAfterSeconds'];
  return { ...Object.fromEntries(keys.filter(key => result[key] !== undefined).map(key => [key, result[key]])),
    ...responseDetails(result) };
}
