// Milestone stub: git smart HTTP. Filled in after the REST surface passes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorBody, sendJson } from './http.ts';

/** Whether a path names a smart-HTTP endpoint: /{owner}/{repo}.git/... */
export function isGitPath(path: string): boolean {
  return /^\/[^/]+\/[^/]+\.git(\/|$)/.test(path);
}

export async function handleGit(_req: IncomingMessage, res: ServerResponse, _path: string): Promise<void> {
  sendJson(res, 404, errorBody('Not Found'));
}
