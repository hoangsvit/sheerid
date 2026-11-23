import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AutomationError, requireValue } from '../core/errors.js';
import { WebJobs } from './jobs.js';
import { isMainModule } from '../../scripts/process.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export function createWebServer({ port = 8787, host = '127.0.0.1', publicOrigin,
  configFile = resolve('config/sheerid.local.json'), workflow } = {}) {
  requireValue(['127.0.0.1', '0.0.0.0'].includes(host), 'Invalid web listener host');
  let published;
  if (publicOrigin) {
    try { published = new URL(publicOrigin); } catch { throw new AutomationError('INVALID_CONFIG', 'Invalid public URL'); }
    requireValue(published.protocol === 'https:' && !published.username && !published.password
      && published.pathname === '/' && !published.search && !published.hash, 'Public origin must be an HTTPS domain');
  }
  requireValue(host !== '0.0.0.0' || published, 'Public listening requires an HTTPS public origin');
  const token = randomBytes(32).toString('hex');
  const jobs = new WebJobs({ configFile, workflow });
  let origin;
  const server = createServer((request, response) => {
    handle(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const status = error.code === 'JOB_NOT_FOUND' ? 404
        : ['SERVER_STOPPING', 'JOB_ACTIVE'].includes(error.code) ? 409
          : error.code === 'STATUS_COOLDOWN' ? 429 : error.code === 'STORAGE_ERROR' ? 503
          : error.code === 'FORBIDDEN' ? 403 : error.code === 'BODY_TOO_LARGE' ? 413
            : error instanceof AutomationError ? 400 : 500;
      json(response, status, { error: { code: error instanceof AutomationError ? error.code : 'WEB_ERROR',
        message: error instanceof AutomationError ? error.message : 'Request processing failed. Please retry.' } });
    });
  });
  server.requestTimeout = 120000;

  function authorize(request, write = false) {
    const address = server.address();
    const hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
    if (published) hosts.push(published.host);
    if (!hosts.includes(request.headers.host)) throw new AutomationError('FORBIDDEN', 'Access is limited to the local workbench');
    const expectedOrigin = published && request.headers.host === published.host ? published.origin : `http://${request.headers.host}`;
    // A trusted reverse proxy may replace Host with localhost:port while
    // retaining the browser's public HTTPS Origin. Trust only our configured
    // public origin; never derive it from arbitrary forwarded headers.
    if (request.headers.origin && request.headers.origin !== expectedOrigin
      && request.headers.origin !== published?.origin) {
      throw new AutomationError('FORBIDDEN', 'Request origin does not match');
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new AutomationError('FORBIDDEN', 'Request origin does not match');
    if (write && request.headers['x-local-token'] !== token) {
      throw new AutomationError('FORBIDDEN', 'Session expired. Refresh the page and retry.');
    }
  }

  async function handle(request, response) {
    authorize(request);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url = new URL(request.url, origin);
    if (request.method === 'GET' && assets.has(url.pathname)) {
      const [filename, type] = assets.get(url.pathname);
      response.writeHead(200, { 'Content-Type': type });
      response.end(await readFile(new URL(`./public/${filename}`, import.meta.url)));
      return;
    }
    authorize(request, request.method !== 'GET');
    if (request.method === 'GET' && url.pathname === '/api/session') {
      json(response, 200, { token });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/form-defaults') {
      const { data = {} } = await jobs.readConfig();
      const profile = {};
      for (const key of ['firstName', 'lastName']) {
        requireValue(typeof data?.[key] === 'string' && data[key].trim().length > 0 && data[key].trim().length <= 150,
          `Provide data.${key} in the configuration to fill saved details`);
        profile[key] = data[key].trim();
      }
      const date = data?.birthDate;
      const timestamp = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
      requireValue(Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date
        && timestamp < Date.now() && Number(date.slice(0, 4)) >= 1900,
      'Provide a valid data.birthDate in YYYY-MM-DD format to fill saved details');
      json(response, 200, { ...profile, birthDate: date });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/jobs') {
      json(response, 200, jobs.list());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/jobs') {
      requireValue(request.headers['content-type']?.split(';')[0] === 'application/json', 'Task requests must use JSON');
      let input;
      try { input = JSON.parse((await readBody(request, 64 * 1024)).toString('utf8')); }
      catch (error) {
        if (error instanceof AutomationError) throw error;
        throw new AutomationError('INVALID_CONFIG', 'Form payload is not valid JSON');
      }
      const job = await jobs.start(input);
      json(response, 202, { job });
      return;
    }
    const jobRoute = url.pathname.match(/^\/api\/jobs\/([a-f\d]{24})(\/(?:cancel|resume|check-status))?$/i);
    if (jobRoute && request.method === 'DELETE' && !jobRoute[2]) {
      json(response, 200, jobs.remove(jobRoute[1]));
      return;
    }
    if (jobRoute && request.method === 'GET' && !jobRoute[2]) {
      const after = Number(url.searchParams.get('after') ?? 0);
      requireValue(Number.isSafeInteger(after) && after >= 0, 'Invalid event cursor');
      json(response, 200, jobs.get(jobRoute[1], after));
      return;
    }
    if (jobRoute?.[2] && request.method === 'POST') {
      const action = jobRoute[2].toLowerCase();
      const job = action === '/check-status' ? await jobs.checkStatus(jobRoute[1])
        : action === '/resume' ? jobs.resume(jobRoute[1]) : jobs.cancel(jobRoute[1]);
      json(response, action === '/check-status' ? 202 : 200, { job });
      return;
    }
    json(response, 404, { error: { code: 'NOT_FOUND', message: 'Page or endpoint not found' } });
  }

  return {
    server, jobs,
    async start() {
      await jobs.initialize();
      await new Promise((resolveStarted, reject) => {
        const fail = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); resolveStarted(); };
        server.once('error', fail);
        server.once('listening', ready);
        server.listen(port, host);
      });
      origin = `http://127.0.0.1:${server.address().port}`;
      return published?.origin ?? origin;
    },
    async close() {
      await jobs.close();
      server.closeAllConnections();
      if (server.listening) await new Promise(resolveClosed => server.close(resolveClosed));
    },
  };
}

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) throw new AutomationError('BODY_TOO_LARGE', 'Request body exceeds the size limit');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new AutomationError('BODY_TOO_LARGE', 'Request body exceeds the size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8787' } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer between 1024 and 65535');
  const app = createWebServer({ port, host: process.env.WORKBENCH_WEB_HOST || '127.0.0.1',
    publicOrigin: process.env.WORKBENCH_WEB_PUBLIC_ORIGIN });
  const shutdown = () => { void app.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  app.start().then(origin => process.stdout.write(`Verification Workbench local console started: ${origin}\nPress Ctrl+C to stop the service.\n`)).catch(error => {
    process.stderr.write(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Specify another port with --port.\n`
      : error instanceof AutomationError ? `Web service failed to start: ${error.message}\n` : 'Web service failed to start.\n');
    process.exitCode = 1;
    void app.close();
  });
}
