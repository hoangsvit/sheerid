import { open } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { AutomationError, requireValue } from '../../core/errors.js';
import { networkFetch } from '../../core/network.js';

const MAX_BYTES = 20 * 1024 * 1024; // Buffering limit, not a claim about a program's upload limit.

export function selectDocumentSource(document = {}, { file, url } = {}, data) {
  requireValue(!(file !== undefined && url !== undefined), 'Specify either --file or --url, not both');
  if (file !== undefined) return { path: file };
  if (url === undefined) {
    requireValue(!(document.path?.trim() && document.url?.trim()), 'Specify either document.path or document.url, not both');
    if (!document.url?.trim()) return { path: document.path };
    url = document.url;
  }
  // Standalone material configs may omit personal data. When supplied, both
  // names are required so the source retrieves the intended original document.
  if (data?.firstName === undefined && data?.lastName === undefined) return { url };
  requireValue(typeof data?.firstName === 'string' && data.firstName.trim().length > 0
    && typeof data?.lastName === 'string' && data.lastName.trim().length > 0,
    'Document lookup by name requires data.firstName and data.lastName');
  const sourceUrl = downloadUrl(url);
  sourceUrl.searchParams.set('name', `${data.firstName.trim()} ${data.lastName.trim()}`);
  return { url: sourceUrl.href };
}

function metadata(bytes, filename) {
  let mimeType;
  let extension;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mimeType = 'image/png'; extension = '.png';
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    mimeType = 'image/jpeg'; extension = '.jpg';
  } else if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    mimeType = 'application/pdf'; extension = '.pdf';
  }
  requireValue(Boolean(mimeType), 'Evidence must be PNG, JPEG or PDF; HTML login pages and JSON responses are not accepted');
  if (filename) {
    const suffix = extname(filename).toLowerCase();
    requireValue(suffix === extension || (extension === '.jpg' && suffix === '.jpeg'),
      'Local evidence filename extension does not match its file signature');
  }
  return { bytes, mimeType, fileSize: bytes.length, fileName: filename ?? `document${extension}` };
}

function downloadUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new AutomationError('INVALID_DOCUMENT_URL', 'Document source is not a valid URL');
  }
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password,
    'Document source supports only HTTP/HTTPS URLs without embedded credentials');
  url.hash = '';
  return url;
}

async function readRemoteDocument(source, { signal, timeoutMs = 120000 } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const downloadSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response;
  try {
    let url = downloadUrl(source);
    for (let redirects = 0; ; redirects++) {
      // A loopback material URL names this computer, not the upstream proxy host.
      // Re-evaluate each redirect so remote destinations still use the configured route.
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      response = await (loopback ? fetch : networkFetch)(url, { signal: downloadSignal, redirect: 'manual',
        cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      requireValue(redirects < 3, 'Document download followed more than three redirects');
      const location = response.headers.get('location');
      requireValue(Boolean(location), 'Document redirect is missing a destination');
      const next = downloadUrl(new URL(location, url).href);
      requireValue(!(url.protocol === 'https:' && next.protocol === 'http:'), 'Document download cannot redirect from HTTPS to HTTP');
      url = next;
    }
    requireValue(response.ok && response.status !== 206, 'Document download did not return a complete successful response');
    const length = response.headers.get('content-length');
    if (length !== null) {
      requireValue(/^\d+$/.test(length) && Number(length) > 0 && Number(length) <= MAX_BYTES,
        'Remote evidence must not be empty or exceed 20 MiB');
    }
    requireValue(Boolean(response.body), 'Document download has no response body');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      requireValue(size <= MAX_BYTES, 'Remote evidence exceeds the 20 MiB size limit');
      chunks.push(chunk);
    }
    downloadSignal.throwIfAborted();
    requireValue(size > 0, 'Remote evidence is empty');
    // Fetch decompresses bodies; compare Content-Length only for unencoded responses.
    if (length !== null && !response.headers.get('content-encoding')) {
      requireValue(size === Number(length), 'Remote evidence download is incomplete');
    }
    return metadata(Buffer.concat(chunks, size));
  } catch (error) {
    if (signal?.aborted) throw new AutomationError('CANCELLED', 'Document download cancelled');
    if (deadline.aborted) throw new AutomationError('DOCUMENT_DOWNLOAD_TIMEOUT', 'Document download timed out');
    if (error instanceof AutomationError) throw error;
    // Do not expose source URLs, query parameters or server response bodies in errors.
    throw new AutomationError('DOCUMENT_DOWNLOAD_FAILED', 'Cannot download the document; check URL and network connection');
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

export async function readDocument(source, options = {}) {
  options.signal?.throwIfAborted();
  if (typeof source === 'string') return readLocalDocument(source, options.signal);
  requireValue(source && !(source.path !== undefined && source.url !== undefined), 'Only one document source may be specified');
  if (source.url !== undefined) return readRemoteDocument(source.url, options);
  return readLocalDocument(source.path, options.signal);
}

async function readLocalDocument(filename, signal) {
  requireValue(typeof filename === 'string' && filename.trim().length > 0,
    'Specify local evidence with --file / document.path or remote evidence with --url / document.url; remote verification state has not changed');
  requireValue(!/^[a-z][a-z\d+.-]*:\/\//i.test(filename), 'document.path accepts only local filesystem paths');
  const path = resolve(filename);
  let file;
  try { file = await open(path, 'r'); } catch (cause) {
    throw new AutomationError('DOCUMENT_UNREADABLE', 'Cannot open specified local evidence file', { cause });
  }
  try {
    const stat = await file.stat();
    requireValue(stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES, 'Evidence must be a nonempty regular file no larger than 20 MiB');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      signal?.throwIfAborted();
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    requireValue(size === stat.size, 'File size changed while reading; wait for the file to finish saving and retry');
    const data = bytes.subarray(0, size);
    return metadata(data, basename(path));
  } finally {
    await file.close();
  }
}
