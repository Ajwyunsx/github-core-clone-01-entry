// The HTTP plumbing every surface shares: JSON replies with the headers GitHub sends, a body
// reader that turns a malformed payload into a 400, and the request id every reply carries.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The largest request body the forge accepts (a pack push is the big one). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Reply with a JSON body and the headers GitHub puts on every answer. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestIdOf(res),
    ...headers,
  });
  res.end(text);
}

/** The request id the current reply carries; one per request, made on first use. */
export function requestIdOf(res: ServerResponse): string {
  const existing = res.getHeader('x-github-request-id');
  if (typeof existing === 'string' && existing !== '') return existing;
  return `forge-${(requestCounter += 1).toString(16).padStart(8, '0')}`;
}

let requestCounter = 0;

/** Assign the reply's request id up front, so an early writeHead still carries one. */
export function stampRequestId(res: ServerResponse): void {
  if (res.getHeader('x-github-request-id') === undefined) {
    requestCounter += 1;
    res.setHeader('x-github-request-id', `forge-${requestCounter.toString(16).padStart(8, '0')}`);
  }
}

/** GitHub's error body: a message, and optionally a documentation url. */
export function errorBody(message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { message, documentation_url: 'https://docs.github.com/rest', ...extra };
}

/** A body that could not be read or parsed: the caller answers 400. */
export class BodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BodyError';
  }
}

/** Read the whole request body as bytes. */
export function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyError('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err: Error) => reject(new BodyError(err.message)));
  });
}

/** Read a JSON body; an empty body is `{}`, and anything unparsable throws BodyError. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  let text: string;
  try {
    text = raw.toString('utf8');
  } catch {
    throw new BodyError('request body is not utf-8');
  }
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError('Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BodyError('Body should be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** The path and query of a request, or a bare '/' when the URL does not parse. */
export function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://forge');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

/** The absolute origin the client used, so a Link header stays on it. */
export function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return typeof host === 'string' && host !== '' ? `http://${host}` : 'http://localhost';
}

/** A token from an Authorization header: `Bearer <token>`, case-insensitive on the scheme. */
export function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^\s*bearer\s+(.+?)\s*$/i.exec(header);
  return match === null ? null : (match[1] as string);
}

/** Whether a string is a 40-character lowercase hex object id. */
export function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The string value of a body field, or '' when absent. */
export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/** A base64 payload as bytes (newlines allowed, as GitHub's docs wrap them). */
export function decodeBase64(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** Bytes as standard base64 with GitHub's 60-column line wrapping. */
export function encodeBase64Wrapped(data: Buffer): string {
  const flat = data.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < flat.length; i += 60) lines.push(flat.slice(i, i + 60));
  return lines.join('\n');
}
