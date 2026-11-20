import { AsyncLocalStorage } from 'node:async_hooks';
import { AutomationError } from './errors.js';
import { parseProxy, upstreamProxyUrl } from './proxy.js';

const networks = new AsyncLocalStorage();

// Runtime scope, not a global dispatcher: nested executors reuse one route,
// while independent library calls can use different proxies safely.
export async function withNetwork(config, operation) {
  const existing = networks.getStore();
  if (existing && existing.configuredProxy === config.proxy) return operation();
  const proxy = parseProxy(config.proxy);
  const runtime = { configuredProxy: config.proxy, browserProxy: undefined, dispatcher: undefined, failed: false };
  if (!proxy) return networks.run(runtime, operation);
  let bridge;
  try {
    const [{ Server }, { ProxyAgent }] = await Promise.all([import('proxy-chain'), import('undici')]);
    const upstream = upstreamProxyUrl(proxy);
    bridge = new Server({
      host: '127.0.0.1', port: 0, verbose: false,
      prepareRequestFunction: () => ({ upstreamProxyUrl: upstream }),
    });
    await bridge.listen();
    bridge.server.on('error', () => { runtime.failed = true; });
    const server = `http://127.0.0.1:${bridge.port}`;
    runtime.browserProxy = { server };
    runtime.dispatcher = new ProxyAgent({ uri: server });
  } catch {
    await runtime.dispatcher?.destroy().catch(() => {});
    await bridge?.close(true).catch(() => {});
    throw new AutomationError('PROXY_START_FAILED', 'Unable to start local proxy adapter; check dependencies and local port permissions. Direct connection was not used');
  }
  try {
    return await networks.run(runtime, operation);
  } finally {
    try { await runtime.dispatcher.destroy(); } finally { await bridge.close(true); }
  }
}

export function browserProxy() {
  return networks.getStore()?.browserProxy;
}

export function networkFetch(url, options = {}) {
  const runtime = networks.getStore();
  if (runtime?.failed) throw new AutomationError('PROXY_UNAVAILABLE', 'Proxy adapter unavailable; request stopped without fallback to direct connection');
  return fetch(url, { ...options, ...(runtime?.dispatcher ? { dispatcher: runtime.dispatcher } : {}) });
}
