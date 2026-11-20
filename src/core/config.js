import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AutomationError, requireValue } from './errors.js';
import { resolveProxy } from './proxy.js';

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function checkKeys(value, allowed, label) {
  requireValue(isRecord(value), `${label} must be an object`);
  requireValue(Object.keys(value).every(key => allowed.includes(key)), `${label} contains unsupported keys`);
}

export function normalizeWebConfig(value = {}) {
  checkKeys(value, ['concurrency'], 'web');
  const concurrency = value.concurrency ?? 1;
  requireValue(Number.isSafeInteger(concurrency) && concurrency >= 1,
    'web.concurrency must be an integer greater than or equal to 1');
  return { concurrency };
}

function timeout(value, fallback, label) {
  const result = value ?? fallback;
  requireValue(Number.isInteger(result) && result >= 1000 && result <= 300000,
    `${label} must be an integer between 1,000 and 300,000 milliseconds`);
  return result;
}

function delayRange(value, fallback, label, limit) {
  const range = value ?? fallback;
  checkKeys(range, ['min', 'max'], label);
  requireValue(Number.isInteger(range.min) && Number.isInteger(range.max)
    && range.min >= 0 && range.max >= range.min && range.max <= limit,
    `${label} must satisfy 0 <= min <= max <= ${limit} (milliseconds, integer)`);
  return { min: range.min, max: range.max };
}

export async function loadConfig(filename, env = process.env) {
  let raw;
  try {
    raw = JSON.parse((await readFile(resolve(filename), 'utf8')).replace(/^\uFEFF/, ''));
  } catch (cause) {
    throw new AutomationError('INVALID_CONFIG', 'The configuration file cannot be read or is not valid JSON', { cause });
  }
  return normalizeConfig(raw, env);
}

// Both the CLI file loader and the local Web form use the same validation.
export async function normalizeConfig(raw, env = process.env) {
  checkKeys(raw, ['app', 'url', 'proxy', 'browser', 'timeouts', 'interaction', 'document', 'data', 'selectors', 'artifactsDir', 'web', 'polling', 'emailDomain'], '配置');
  const web = normalizeWebConfig(raw.web);
  const polling = raw.polling ?? {};
  const rawDomain = raw.data?.organization?.emailDomain ?? raw.emailDomain ?? raw.data?.emailDomain;
  requireValue(rawDomain === undefined || typeof rawDomain === 'string', 'emailDomain must be a string');
  const emailDomain = typeof rawDomain === 'string' ? rawDomain.trim().replace(/^@+/, '') : '';
  if (emailDomain) {
    requireValue(/^[^\s@]+\.[^\s@]+$/.test(emailDomain), 'Invalid emailDomain format; expected a domain such as example.edu');
  }
  checkKeys(polling, ['intervalMs'], 'polling');
  const intervalMs = timeout(polling.intervalMs, 5000, 'polling.intervalMs');
  requireValue(typeof raw.app === 'string' && /^[a-z][a-z0-9-]*$/.test(raw.app), 'Invalid app format');
  const browser = raw.browser ?? {};
  const timeouts = raw.timeouts ?? {};
  const interaction = raw.interaction ?? {};
  const document = raw.document ?? {};
  checkKeys(document, ['path', 'url'], 'document');
  requireValue(document.path === undefined || typeof document.path === 'string', 'document.path must be a local filesystem path string');
  requireValue(document.url === undefined || typeof document.url === 'string', 'document.url must be a URL string');
  requireValue(!(document.path?.trim() && document.url?.trim()), 'Specify only one of document.path or document.url');
  checkKeys(interaction, ['keyDelayMs', 'fieldDelayMs', 'submitDelayMs'], 'interaction');
  checkKeys(browser, ['headless', 'locale', 'keepOpen', 'autoFill'], 'browser');
  checkKeys(timeouts, ['apiMs', 'downloadMs', 'uploadMs', 'actionMs', 'navigationMs', 'readyMs', 'humanMs', 'resultMs'], 'timeouts');
  requireValue(browser.headless === undefined || typeof browser.headless === 'boolean', 'headless must be a boolean');
  requireValue(browser.keepOpen === undefined || typeof browser.keepOpen === 'boolean', 'keepOpen must be a boolean');
  requireValue(browser.autoFill === undefined || typeof browser.autoFill === 'boolean', 'autoFill must be a boolean');
  requireValue(browser.autoFill !== false || (browser.headless !== true && browser.keepOpen !== false),
    'Manual input mode requires headless: false and keepOpen: true');
  requireValue(!(browser.headless === true && browser.keepOpen === true), 'Headless mode cannot keep the browser open');
  requireValue(browser.locale === undefined || (typeof browser.locale === 'string' && browser.locale.length > 0), 'Invalid locale format');
  requireValue(raw.artifactsDir === undefined || (typeof raw.artifactsDir === 'string' && raw.artifactsDir.length > 0), 'Invalid artifactsDir format');
  let url;
  try { url = new URL(env.AUTOMATION_URL || raw.url); } catch {
    throw new AutomationError('INVALID_CONFIG', 'url or AUTOMATION_URL must be a valid URL');
  }
  requireValue(url.protocol === 'https:' && !url.username && !url.password, 'Only HTTPS URLs without embedded credentials are supported');
  return {
    app: raw.app, url: url.href, data: raw.data, selectors: raw.selectors ?? {}, web, polling: { intervalMs }, emailDomain,
    // An empty AUTOMATION_PROXY falls back to the config file instead of forcing a value.
    proxy: await resolveProxy(env.AUTOMATION_PROXY?.trim() ? env.AUTOMATION_PROXY : raw.proxy, env),
    document: { path: document.path ?? '', url: document.url ?? '' },
    browser: {
      headless: browser.headless ?? false,
      locale: browser.locale ?? 'en-US',
      keepOpen: browser.keepOpen ?? !(browser.headless ?? false),
      autoFill: browser.autoFill ?? true,
    },
    timeouts: {
      apiMs: timeout(timeouts.apiMs, 20000, 'apiMs'),
      downloadMs: timeout(timeouts.downloadMs, 120000, 'downloadMs'),
      uploadMs: timeout(timeouts.uploadMs, 120000, 'uploadMs'),
      actionMs: timeout(timeouts.actionMs, 15000, 'actionMs'),
      navigationMs: timeout(timeouts.navigationMs, 60000, 'navigationMs'),
      readyMs: timeout(timeouts.readyMs, 120000, 'readyMs'),
      humanMs: timeout(timeouts.humanMs, 180000, 'humanMs'),
      resultMs: timeout(timeouts.resultMs, 45000, 'resultMs'),
    },
    interaction: {
      keyDelayMs: delayRange(interaction.keyDelayMs, { min: 40, max: 120 }, 'keyDelayMs', 1000),
      fieldDelayMs: delayRange(interaction.fieldDelayMs, { min: 500, max: 1200 }, 'fieldDelayMs', 10000),
      submitDelayMs: delayRange(interaction.submitDelayMs, { min: 1000, max: 2000 }, 'submitDelayMs', 10000),
    },
    artifactsDir: resolve(raw.artifactsDir ?? '.runs'),
  };
}
