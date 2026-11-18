// The Model Context Protocol endpoint: JSON-RPC 2.0 over streamable HTTP at /mcp.
// Speaks both protocol eras — the modern 2026-07-28 server/discover and the legacy
// initialize handshake — and exposes six forge tools: repos, issues, pull requests.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerOf, errorBody, readRawBody, sendJson } from './http.ts';
import { forge, VIEWER_LOGIN } from './store.ts';
import type { Issue, PullRequest, Repository } from './store.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

// ---------------------------------------------------------------- json-rpc error codes

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

// ---------------------------------------------------------------- auth

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The bearer gate: a missing or wrong token refuses the request. */
function authorize(req: IncomingMessage): boolean {
  const token = bearerOf(req);
  if (token === null || token === '') return false;
  if (TOKEN !== '' && token !== TOKEN) return false;
  return true;
}

// ---------------------------------------------------------------- server identity

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function capabilities(): Record<string, unknown> {
  return { tools: {} };
}

// ---------------------------------------------------------------- json-rpc helpers

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** A successful tool result: structuredContent and content[0].text carry the same JSON. */
function toolOk(obj: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
    isError: false,
  };
}

/** A tool execution error: the check reads isError or the JSON-RPC error code. */
function toolFail(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

// ---------------------------------------------------------------- forge helpers

/** Look a repository up. Only the token owner's repos are visible, as REST's repoOr404. */
function repoOrNull(owner: string, name: string): Repository | null {
  if (owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) return null;
  return forge.repo(owner, name) ?? null;
}

function strArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function numArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** The required arguments that are absent or empty. */
function missingArgs(args: Record<string, unknown>, required: readonly string[]): string[] {
  return required.filter((key) => {
    const value = args[key];
    return value === undefined || value === null || value === '';
  });
}

/** Whether merging head into base would conflict (the same rule REST uses). */
function hasConflict(repo: Repository, headSha: string, baseSha: string): boolean {
  const base = forge.mergeBase(headSha, baseSha);
  if (base === undefined) return false;
  const ancestor = forge.filesAt(base);
  const head = forge.filesAt(headSha);
  const target = forge.filesAt(baseSha);
  const paths = new Set<string>([...ancestor.keys(), ...head.keys(), ...target.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path);
    const h = head.get(path);
    const t = target.get(path);
    const headChanged = (a?.sha ?? '') !== (h?.sha ?? '');
    const targetChanged = (a?.sha ?? '') !== (t?.sha ?? '');
    if (headChanged && targetChanged && (h?.sha ?? '') !== (t?.sha ?? '')) return true;
  }
  return false;
}

// ---------------------------------------------------------------- the tools
//
// Built ONCE at module level: the idempotency check compares two tools/list
// answers byte for byte, so the array must never be rebuilt per request.

const TOOLS: readonly Record<string, unknown>[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository on the forge',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository should be private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body text' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a new pull request from a head branch into a base branch',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The pull request title' },
        head: { type: 'string', description: 'The head branch (source)' },
        base: { type: 'string', description: 'The base branch (target)' },
        body: { type: 'string', description: 'The pull request body text' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        pull_number: { type: 'number', description: 'The pull request number to merge' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

// ---------------------------------------------------------------- tool dispatch

/**
 * Run one tool. Returns a tool result on success or tool failure, null for an unknown
 * tool name (the caller answers JSON-RPC -32602).
 */
function dispatchTool(name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  switch (name) {
    case 'create_repo': {
      const missing = missingArgs(args, ['name']);
      if (missing.length > 0) return toolFail(`Missing required arguments: ${missing.join(', ')}`);
      const repoName = strArg(args, 'name').trim();
      if (repoName === '') return toolFail('Repository name is required');
      if (forge.repo(VIEWER_LOGIN, repoName) !== undefined) return toolFail('Repository creation failed: name already exists on this account');
      const repo = forge.createRepo(VIEWER_LOGIN, repoName, {
        description: strArg(args, 'description'),
        private: args.private === true,
      });
      return toolOk(repoJson(repo));
    }

    case 'get_repo': {
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing.length > 0) return toolFail(`Missing required arguments: ${missing.join(', ')}`);
      const repo = repoOrNull(strArg(args, 'owner'), strArg(args, 'repo'));
      if (repo === null) return toolFail('Not Found');
      return toolOk(repoJson(repo));
    }

    case 'create_issue': {
      const missing = missingArgs(args, ['owner', 'repo', 'title']);
      if (missing.length > 0) return toolFail(`Missing required arguments: ${missing.join(', ')}`);
      const repo = repoOrNull(strArg(args, 'owner'), strArg(args, 'repo'));
      if (repo === null) return toolFail('Not Found');
      const title = strArg(args, 'title');
      if (title === '') return toolFail('title is required');
      const now = forge.clock.nextIso();
      const issue: Issue = {
        id: forge.issueId(),
        number: repo.nextIssueNumber,
        title,
        body: strArg(args, 'body'),
        state: 'open',
        labels: [],
        user: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
      };
      repo.nextIssueNumber += 1;
      repo.issues.set(issue.number, issue);
      repo.updatedAt = now;
      return toolOk(issueJson(repo, issue));
    }

    case 'list_issues': {
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing.length > 0) return toolFail(`Missing required arguments: ${missing.join(', ')}`);
      const repo = repoOrNull(strArg(args, 'owner'), strArg(args, 'repo'));
      if (repo === null) return toolFail('Not Found');
      const state = strArg(args, 'state') || 'open';
      let items = [...repo.issues.values()];
      if (state !== 'all') items = items.filter((issue) => issue.state === state);
      items.sort((a, b) => b.number - a.number);
      return toolOk({ issues: items.map((issue) => issueJson(repo, issue)) });
    }

    case 'create_pull_request': {
      const missing = missingArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing.length > 0) return toolFail(`Missing required arguments: ${missing.join(', ')}`);
      const repo = repoOrNull(strArg(args, 'owner'), strArg(args, 'repo'));
      if (repo === null) return toolFail('Not Found');
      const head = strArg(args, 'head');
      const base = strArg(args, 'base') || repo.defaultBranch;
      const title = strArg(args, 'title');
      if (head === '') return toolFail('head is required');
      if (forge.branchSha(repo, head) === undefined) return toolFail('No commits between the base and the head');
      if (forge.branchSha(repo, base) === undefined) return toolFail(`Base branch ${base} does not exist`);
      const now = forge.clock.nextIso();
      const pull: PullRequest = {
        id: forge.pullId(),
        number: repo.nextPullNumber,
        title: title === '' ? `${head} into ${base}` : title,
        body: strArg(args, 'body'),
        state: 'open',
        head,
        base,
        user: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        mergedBy: null,
      };
      repo.nextPullNumber += 1;
      repo.pulls.set(pull.number, pull);
      repo.updatedAt = now;
      return toolOk(pullJson(repo, pull));
    }

    case 'merge_pull_request': {
      const missing = missingArgs(args, ['owner', 'repo', 'pull_number']);
      if (missing.length > 0) return toolFail(`Missing required arguments: ${missing.join(', ')}`);
      const repo = repoOrNull(strArg(args, 'owner'), strArg(args, 'repo'));
      if (repo === null) return toolFail('Not Found');
      const number = numArg(args, 'pull_number');
      if (number === null) return toolFail('pull_number must be an integer');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolFail('Not Found');
      const headSha = forge.branchSha(repo, pull.head);
      const baseSha = forge.branchSha(repo, pull.base);
      if (headSha === undefined || baseSha === undefined) return toolFail('Pull request is not mergeable');
      if (pull.merged) return toolFail('Pull request is not mergeable');
      if (hasConflict(repo, headSha, baseSha)) return toolFail('Pull request is not mergeable: merge conflict');
      const files = forge.filesAt(headSha);
      const mergeSha = forge.commitFiles(files, [baseSha], `Merge pull request #${pull.number} from ${pull.head}`, forge.clock.nextSec());
      repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = forge.clock.nextIso();
      pull.mergeCommitSha = mergeSha;
      pull.mergedBy = VIEWER_LOGIN;
      pull.updatedAt = pull.mergedAt;
      repo.updatedAt = pull.mergedAt;
      return toolOk({ sha: mergeSha, merged: true, message: `Pull request #${pull.number} merged` });
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------- the endpoint

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  // The legacy session close: accept any session id, answer 200.
  if (method === 'DELETE') {
    sendJson(res, 200, {});
    return;
  }

  if (method !== 'POST') {
    sendJson(res, 404, errorBody('Not Found'));
    return;
  }

  // Auth gate on every POST, before any method dispatch.
  if (!authorize(req)) {
    sendJson(res, 401, errorBody('Requires authentication'));
    return;
  }

  // Read and parse the body; anything that is not JSON is a parse error.
  let raw: Buffer;
  try {
    raw = await readRawBody(req);
  } catch {
    sendJson(res, 400, rpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error'));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error'));
    return;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, rpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error'));
    return;
  }

  const request = parsed as JsonRpcRequest;
  const id: JsonRpcId = request.id ?? null;
  const rpcMethod = typeof request.method === 'string' ? request.method : '';
  const params: Record<string, unknown> =
    typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : {};

  // Dispatch on the JSON-RPC method, both eras.
  switch (rpcMethod) {
    case 'server/discover': {
      const info = serverInfo();
      const result: Record<string, unknown> = {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: capabilities(),
        serverInfo: info,
        _meta: {
          'io.modelcontextprotocol/serverInfo': info,
        },
      };
      sendJson(res, 200, rpcResult(id, result));
      return;
    }

    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' && params.protocolVersion !== '' ? params.protocolVersion : PROTOCOL_VERSION;
      const result: Record<string, unknown> = {
        protocolVersion: requested,
        capabilities: capabilities(),
        serverInfo: serverInfo(),
      };
      sendJson(res, 200, rpcResult(id, result));
      return;
    }

    case 'notifications/initialized': {
      // A notification carries no id; the legacy client ignores the body.
      sendJson(res, 200, { jsonrpc: '2.0', id: null, result: {} });
      return;
    }

    case 'tools/list': {
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
      return;
    }

    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs: Record<string, unknown> =
        typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      const result = dispatchTool(toolName, toolArgs);
      if (result === null) {
        sendJson(res, 200, rpcError(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${toolName}`));
        return;
      }
      sendJson(res, 200, rpcResult(id, result));
      return;
    }

    default: {
      sendJson(res, 200, rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${rpcMethod}`));
      return;
    }
  }
}
