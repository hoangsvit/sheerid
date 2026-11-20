import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normalizeConfig, normalizeWebConfig, checkKeys } from '../core/config.js';
import { AutomationError, requireValue } from '../core/errors.js';
import { withLogSink } from '../core/logger.js';
import { runWorkflow } from '../core/workflow.js';
import { verificationIdFromUrl } from '../apps/sheerid/client.js';

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
  }

  async readConfig() {
    try { return JSON.parse((await readFile(this.configFile, 'utf8')).replace(/^\uFEFF/, '')); }
    catch { throw new AutomationError('INVALID_CONFIG', 'Configuration file cannot be read or is not valid JSON'); }
  }

  async initialize() {
    const raw = await this.readConfig();
    this.concurrency = normalizeWebConfig(raw?.web).concurrency;
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
      sequence: 0, events: [], controller: new AbortController(), config, done, resolveDone,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.record(job, { event: 'web_queued', stage: 'queued', mode: job.mode });
    this.drain();
    return this.snapshot(job);
  }

  drain() {
    if (this.closing || this.draining) return;
    this.draining = true;
    try {
      while (this.running.size < this.concurrency && this.queue.length) {
        const job = this.jobs.get(this.queue.shift());
        if (job.state !== 'queued') continue;
        job.state = 'running';
        job.startedAt = new Date().toISOString();
        this.running.add(job.id);
        this.record(job, { event: 'web_started', stage: 'starting', mode: job.mode });
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
    if (record.event === 'run_finished') job.result = publicResult(record);
  }

  async execute(job, config) {
    try {
      const result = await withLogSink(record => this.record(job, record), () => this.workflow(config, {
        submit: job.mode === 'submit', signal: job.controller.signal, resumeUncertainStage: job.resumeUncertainStage,
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
    // Stopped jobs retain their original settings for an explicit resume.
    if (job.state !== 'cancelled') delete job.config;
    this.record(job, { event: 'web_finished', ...job.result });
    this.running.delete(job.id);
    job.resolveDone();
    this.drain();
  }

  snapshot(job) {
    return { id: job.id, verificationId: job.id, mode: job.mode, state: job.state, stage: job.stage,
      queuePosition: job.state === 'queued' ? this.queue.indexOf(job.id) + 1 : null,
      queuedAt: job.queuedAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      result: job.result, lastSequence: job.sequence };
  }

  list() {
    return { concurrency: this.concurrency, running: this.running.size, queued: this.queue.length,
      jobs: [...this.jobs.values()].map(job => this.snapshot(job)) };
  }

  get(id, after = 0) {
    const job = this.jobs.get(id.toLowerCase());
    if (!job) throw new AutomationError('JOB_NOT_FOUND', 'Task not found or expired');
    return { job: this.snapshot(job), events: job.events.filter(event => event.sequence > after) };
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
    const job = this.jobs.get(id.toLowerCase());
    if (!job) throw new AutomationError('JOB_NOT_FOUND', 'Task not found or expired');
    // Repeated clicks are idempotent. Cleanup must finish before a fresh run.
    if (['queued', 'running'].includes(job.state)) return this.snapshot(job);
    if (job.state !== 'cancelled' || !job.finishedAt || !job.config) {
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
    this.drain();
    return this.snapshot(job);
  }

  remove(id) {
    if (this.closing) throw new AutomationError('SERVER_STOPPING', 'Service is shutting down');
    const job = this.jobs.get(id.toLowerCase());
    if (!job) throw new AutomationError('JOB_NOT_FOUND', 'Task not found or expired');
    if (!job.finishedAt || !['completed', 'failed', 'cancelled'].includes(job.state)
      || this.running.has(job.id) || this.queue.includes(job.id)) {
      throw new AutomationError('JOB_ACTIVE', 'Stop the task and wait for cleanup before deleting it');
    }
    this.jobs.delete(job.id);
    return { id: job.id, deleted: true };
  }

  async close() {
    this.closing = true;
    await this.admissions;
    for (const job of this.jobs.values()) if (!job.finishedAt) this.cancel(job.id);
    await Promise.all([...this.jobs.values()].map(job => job.done));
  }
}

function publicResult(result = {}) {
  const keys = ['status', 'code', 'message', 'stage', 'runId', 'currentStep', 'errorIds',
    'durationMs', 'browserOpened', 'submissionAttempted', 'remoteWriteAttempted',
    'lastKnownStep', 'documentRunId', 'documentStage', 'uploadAttempt', 'rejectionReasons', 'submissionUncertain', 'uncertainStage'];
  return Object.fromEntries(keys.filter(key => result[key] !== undefined).map(key => [key, result[key]]));
}
