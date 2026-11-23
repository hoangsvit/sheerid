import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createWebServer } from '../src/web/server.js';
import { webConfig } from './fixtures/web-config.js';

const publicOrigin = 'https://workspace.example.com';

test('Public deployment requires an explicit HTTPS origin without an application password', () => {
  assert.doesNotThrow(() => createWebServer({ host: '0.0.0.0', publicOrigin }));
  assert.throws(() => createWebServer({ host: '0.0.0.0' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => createWebServer({ publicOrigin: 'http://workspace.example.com' }), { code: 'INVALID_CONFIG' });
});

test('Public HTTPS origin connects without login, keeps origin/token checks and supports queue requests', async t => {
  const { configFile } = await webConfig(t);
  const app = createWebServer({ port: 0, host: '0.0.0.0', publicOrigin, configFile,
    workflow: async () => ({ status: 'pending' }) });
  await app.start();
  t.after(() => app.close());
  const call = (path, headers = {}, body) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: app.server.address().port, path,
      method: body ? 'POST' : 'GET', headers: { Host: 'workspace.example.com', ...headers } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    req.on('error', reject); req.end(body);
  });
  for (const path of ['/', '/app.js', '/style.css']) {
    const asset = await call(path);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['www-authenticate'], undefined);
    assert.ok(!asset.text.includes('Access password'));
    assert.ok(!asset.text.includes('local-dev-only'));
  }
  assert.equal((await call('/api/jobs')).status, 200);
  const session = await call('/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.headers['set-cookie'], undefined);
  assert.equal(session.headers['www-authenticate'], undefined);
  const token = JSON.parse(session.text).token;
  const body = JSON.stringify({ url: 'https://my.sheerid.com/rest/v2/verification/aaaaaaaaaaaaaaaaaaaaaaaa',
    firstName: 'Test', lastName: 'Student', birthDate: '2000-01-02' });
  const headers = { Origin: publicOrigin, 'Content-Type': 'application/json', 'X-Local-Token': token };
  assert.equal((await call('/api/jobs', { 'Content-Type': 'application/json' }, body)).status, 403);
  assert.equal((await call('/api/jobs', headers, body)).status, 202);
  assert.equal((await call('/api/jobs', { ...headers, Host: `localhost:${app.server.address().port}` }, body)).status, 202);
  assert.equal((await call('/api/jobs', { ...headers, Host: `127.0.0.1:${app.server.address().port}` }, body)).status, 202);
  assert.equal((await call('/api/jobs', { ...headers, Host: `localhost:${app.server.address().port}`, Origin: 'https://evil.example' }, body)).status, 403);
  assert.equal((await call('/api/jobs', { ...headers, Origin: 'https://evil.example' }, body)).status, 403);
  assert.equal((await call('/api/jobs', { ...headers, 'X-Local-Token': 'wrong' }, body)).status, 403);
  assert.equal((await call('/api/jobs', { ...headers, Host: 'evil.example' })).status, 403);
  assert.equal((await call('/api/jobs', { ...headers, 'Sec-Fetch-Site': 'cross-site' }, body)).status, 403);
  assert.equal((await call('/config/sheerid.local.json')).status, 404);
});
