import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AutomationError } from '../core/errors.js';

// One writer owns a history file. Replace it atomically so interrupted writes
// leave the previous history intact. No submitted identities or proxies go here.
export class JobStore {
  constructor(filename) {
    this.filename = filename;
    this.lockFile = `${filename}.lock`;
  }

  open() {
    mkdirSync(dirname(this.filename), { recursive: true });
    try {
      this.lock = openSync(this.lockFile, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(readFileSync(this.lockFile, 'utf8')); } catch { /* fail closed */ }
      if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) {
        throw new AutomationError('STORAGE_ERROR', 'Job history lock is invalid; check that the old service has stopped');
      }
      try {
        process.kill(owner.pid, 0);
        throw new AutomationError('STORAGE_ERROR', 'Another service owns this job history; stop it before restarting');
      } catch (cause) {
        if (cause.code !== 'ESRCH') throw cause;
      }
      unlinkSync(this.lockFile);
      this.lock = openSync(this.lockFile, 'wx', 0o600);
    }
    this.ownsLock = true;
    try {
      writeFileSync(this.lock, JSON.stringify({ pid: process.pid }));
    } finally {
      closeSync(this.lock);
      this.lock = undefined;
    }
  }

  read() {
    let text;
    try { text = readFileSync(this.filename, 'utf8'); }
    catch (cause) {
      if (cause.code === 'ENOENT') return [];
      throw new AutomationError('STORAGE_ERROR', 'Cannot read saved job history', { cause });
    }
    try {
      const history = JSON.parse(text);
      if (history.version !== 1 || !Array.isArray(history.jobs)) throw new Error('Unsupported history format');
      return history.jobs;
    } catch (cause) {
      throw new AutomationError('STORAGE_ERROR', 'Saved job history is invalid; restore the history file before starting', { cause });
    }
  }

  write(jobs) {
    const temporary = `${this.filename}.tmp`;
    let handle;
    try {
      handle = openSync(temporary, 'w', 0o600);
      writeFileSync(handle, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`);
      closeSync(handle);
      handle = undefined;
      renameSync(temporary, this.filename);
    } catch (cause) {
      if (handle !== undefined) closeSync(handle);
      throw new AutomationError('STORAGE_ERROR', 'Cannot save job history; no new tasks can start until storage is available', { cause });
    }
  }

  close() {
    if (!this.ownsLock) return;
    this.ownsLock = false;
    try { unlinkSync(this.lockFile); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
}
