// Milestone stub: the GraphQL v4 endpoint. Filled in after the REST surface passes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorBody, sendJson } from './http.ts';

export async function handleGraphql(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 404, errorBody('Not Found'));
}
