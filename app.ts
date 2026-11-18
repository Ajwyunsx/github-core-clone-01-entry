// The forge's HTTP surface: one listener, every route. main.ts owns the lifecycle (bind, register,
// wait for done); this file owns what the suite talks to.
//
//   /healthz                 the env's boot probe
//   /api/v3[/...]            GitHub REST v3 (rest.ts)
//   /api/graphql             GitHub GraphQL v4 (graphql.ts)
//   /mcp                     Model Context Protocol over streamable HTTP (mcp.ts)
//   /{owner}/{repo}.git/...  git smart HTTP, upload-pack v2 and receive-pack v0 (git.ts)
//   anything else            a JSON 404, never HTML

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { errorBody, sendJson, stampRequestId } from './http.ts';
import { runRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit, isGitPath } from './git.ts';

/** Answer one request; never lets a throw escape as an HTML error page. */
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Every reply carries a request id, including this one's errors.
  stampRequestId(res);

  const url = req.url ?? '/';
  const path = (() => {
    try {
      return new URL(url, 'http://forge').pathname;
    } catch {
      return '/';
    }
  })();
  const method = (req.method ?? 'GET').toUpperCase();

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/graphql' || path === '/api/graphql/') {
    await handleGraphql(req, res);
    return;
  }

  if (path === '/mcp' || path === '/mcp/') {
    await handleMcp(req, res);
    return;
  }

  if (isGitPath(path)) {
    if (method !== 'GET' && method !== 'POST') {
      sendJson(res, 404, errorBody('Not Found'));
      return;
    }
    await handleGit(req, res, path);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (await runRest(req, res)) return;
  }

  sendJson(res, 404, errorBody('Not Found'));
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, errorBody(message === '' ? 'Internal Server Error' : `Internal Server Error: ${message}`));
    });
  });
}
