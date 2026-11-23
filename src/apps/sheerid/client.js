import { fetchData } from '../../core/http.js';
import { AutomationError, requireValue } from '../../core/errors.js';
import { parseVerification, verificationErrorDetails } from './verification-state.js';
export { parseVerification } from './verification-state.js';

export function verificationIdFromUrl(value) {
  const url = new URL(value);
  const page = url.origin === 'https://services.sheerid.com' && /^\/verify\/[a-f\d]{24}\/?$/i.test(url.pathname);
  const api = ['https://my.sheerid.com', 'https://services.sheerid.com'].includes(url.origin)
    && /^\/rest\/v2\/verification\/[a-f\d]{24}\/?$/i.test(url.pathname);
  requireValue(page || api, 'url must be a SheerID verification page or status endpoint');
  const id = page ? url.searchParams.get('verificationId') : url.pathname.replace(/\/$/, '').split('/').pop();
  requireValue(typeof id === 'string' && /^[a-f\d]{24}$/i.test(id), 'URL is missing a valid verificationId');
  return id.toLowerCase();
}

export function createVerificationClient(config, signal) {
  const verificationId = verificationIdFromUrl(config.url);
  const base = `https://my.sheerid.com/rest/v2/verification/${verificationId}`;
  async function request(method, step, json) {
    const body = await fetchData(step ? `${base}/step/${step}` : base, {
      method, json, signal, timeoutMs: config.timeouts.apiMs,
      parseErrorBody: body => verificationErrorDetails(body, verificationId),
    });
    return { body, state: { ...parseVerification(body, verificationId),
      stateConfirmed: true, stateCheckedAt: new Date().toISOString() } };
  }
  return {
    verificationId,
    getStatus: () => request('GET'),
    cancelSso: () => request('DELETE', 'sso'),
    initiateUpload: files => request('POST', 'docUpload', { files }),
    completeUpload: () => request('POST', 'completeDocUpload'),
    upload: (url, document) => fetchData(url, {
      method: 'PUT', binary: true, bytes: document.bytes, mimeType: document.mimeType,
      timeoutMs: config.timeouts.uploadMs, signal,
    }),
  };
}

export function validateUploadUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new AutomationError('INVALID_UPLOAD_URL', 'API did not return a valid upload URL');
  }
  const allowed = ['.amazonaws.com', '.amazonaws.com.cn', '.sheerid.com']
    .some(suffix => url.hostname.endsWith(suffix));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !allowed) {
    throw new AutomationError('INVALID_UPLOAD_URL', 'Upload URL is not a supported HTTPS S3/SheerID URL; workflow stopped');
  }
  return url.href;
}
