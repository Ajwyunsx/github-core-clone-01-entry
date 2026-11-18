// The GitHub GraphQL v4 surface: one tiny GraphQL engine (lexer, parser, evaluator) wired to the same
// store the REST surface reads, so an issue made over GraphQL is the issue REST lists and vice versa.
//
// No packages: the language subset here is exactly what gh and github-mcp-server send — named and
// anonymous operations, variables, inline enum lists and input objects, fragments and inline fragments,
// aliases, `__type` probes and operation batching (a JSON array body).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerOf, readRawBody, sendJson } from './http.ts';
import { VIEWER_LOGIN, forge } from './store.ts';
import type { FileEntry, Issue, PullRequest, Repository } from './store.ts';

/** The bearer token every call must carry, from the trial's environment. */
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// ---------------------------------------------------------------- errors

/** A GraphQL-level failure: reported in the 200 body's `errors` array, never as an HTTP status. */
class GqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GqlError';
  }
}

// ---------------------------------------------------------------- lexer

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', ',', '$', '!', '=', '@', '&', '|']);

function unescapeString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] as string;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    const esc = raw[i] ?? '';
    if (esc === 'n') out += '\n';
    else if (esc === 't') out += '\t';
    else if (esc === 'r') out += '\r';
    else if (esc === 'b') out += '\b';
    else if (esc === 'f') out += '\f';
    else if (esc === 'u') {
      const hex = raw.slice(i + 1, i + 5);
      out += String.fromCharCode(Number.parseInt(hex, 16) || 0);
      i += 4;
    } else out += esc;
  }
  return out;
}

/** Split a document into tokens. Commas and comments are insignificant, as GraphQL says. */
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const length = source.length;
  while (i < length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const stop = end === -1 ? length : end;
        tokens.push({ kind: 'string', value: source.slice(i + 3, stop) });
        i = stop + 3;
        continue;
      }
      let j = i + 1;
      let raw = '';
      while (j < length) {
        const c = source[j] as string;
        if (c === '\\') {
          raw += c + (source[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (c === '"') break;
        raw += c;
        j += 1;
      }
      tokens.push({ kind: 'string', value: unescapeString(raw) });
      i = j + 1;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i + 1;
      let float = false;
      while (j < length && /[0-9.eE+-]/.test(source[j] as string)) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') float = true;
        j += 1;
      }
      tokens.push({ kind: float ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlError(`Unexpected character ${JSON.stringify(ch)} in the document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'enum'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: [string, GqlValue][] };

type ArgMap = [string, GqlValue][];

type SelNode =
  | { kind: 'field'; alias: string | undefined; name: string; args: ArgMap; selection: SelNode[] }
  | { kind: 'inline'; typeCondition: string | undefined; selection: SelNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | undefined;
  selection: SelNode[];
}

interface ParsedDocument {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selection: SelNode[] }>;
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GqlError(`Parse error: expected "${value}" but found "${token.value}"`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GqlError(`Parse error: expected a name but found "${token.value}"`);
    return token.value;
  }

  parseDocument(): ParsedDocument {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: SelNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: undefined, selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'fragment') {
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new GqlError('Parse error: a fragment needs "on Type"');
        const typeCondition = this.expectName();
        fragments.set(name, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
        throw new GqlError(`Parse error: unexpected "${keyword}" at the top level`);
      }
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.expectName();
      if (this.isPunct('(')) this.skipBalanced('(', ')');
      this.skipDirectives();
      const selection = this.parseSelectionSet();
      operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selection });
    }
    if (operations.length === 0) throw new GqlError('Parse error: the document holds no operation');
    return { operations, fragments };
  }

  private skipBalanced(open: string, close: string): void {
    this.expectPunct(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new GqlError(`Parse error: unterminated "${open}"`);
      if (token.kind === 'punct' && token.value === open) depth += 1;
      else if (token.kind === 'punct' && token.value === close) depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.skipBalanced('(', ')');
    }
  }

  private parseSelectionSet(): SelNode[] {
    this.expectPunct('{');
    const selection: SelNode[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'eof') throw new GqlError('Parse error: unterminated selection set');
      selection.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selection;
  }

  private parseSelection(): SelNode {
    if (this.isPunct('...')) {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name' && this.peek().value !== 'on') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: undefined, selection: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: ArgMap = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push([argName, this.parseValue()]);
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selection = this.isPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): GqlValue {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'var', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const values: GqlValue[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields: [string, GqlValue][] = [];
      while (!this.isPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields.push([key, this.parseValue()]);
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    this.next();
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true' || token.value === 'false') return { kind: 'bool', value: token.value === 'true' };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GqlError(`Parse error: unexpected token "${token.value}" in a value`);
  }
}

// ---------------------------------------------------------------- values

/** Evaluate an argument value against the request's variables. */
function evalValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return value.value;
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => evalValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = evalValue(entry, variables);
      return out;
    }
    default:
      return undefined;
  }
}

function evalArgs(args: ArgMap, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of args) out[name] = evalValue(value, variables);
  return out;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

// ---------------------------------------------------------------- the node model

interface GNode {
  __t: string;
  v: unknown;
}

function gnode(type: string, value: unknown): GNode {
  return { __t: type, v: value };
}

function isNode(value: unknown): value is GNode {
  return value !== null && typeof value === 'object' && '__t' in (value as Record<string, unknown>);
}

type Resolver = (parent: unknown, args: Record<string, unknown>) => unknown;
type TypeDef = Record<string, Resolver>;

// ---------------------------------------------------------------- global ids

function repoGlobalId(repo: Repository): string {
  return `R_${repo.id}`;
}

function issueGlobalId(issue: Issue): string {
  return `I_${issue.id}`;
}

function pullGlobalId(pull: PullRequest): string {
  return `P_${pull.id}`;
}

function commentGlobalId(id: number): string {
  return `C_${id}`;
}

/** Every repository, in creation order: the id space is global, so lookups scan it. */
function allRepos(): Repository[] {
  return [...forge.repos.values()].sort((a, b) => a.id - b.id);
}

function findRepoById(id: string): Repository | undefined {
  const match = /^R_(\d+)$/.exec(id);
  if (match !== null) {
    const numeric = Number(match[1]);
    return allRepos().find((repo) => repo.id === numeric);
  }
  if (/^\d+$/.test(id)) return allRepos().find((repo) => repo.id === Number(id));
  return undefined;
}

function findIssueById(id: string): { repo: Repository; issue: Issue } | undefined {
  const match = /^I_(\d+)$/.exec(id);
  const numeric = match !== null ? Number(match[1]) : /^\d+$/.test(id) ? Number(id) : NaN;
  if (!Number.isFinite(numeric)) return undefined;
  for (const repo of allRepos()) {
    for (const issue of repo.issues.values()) if (issue.id === numeric) return { repo, issue };
  }
  return undefined;
}

function findPullById(id: string): { repo: Repository; pull: PullRequest } | undefined {
  const match = /^P_(\d+)$/.exec(id);
  const numeric = match !== null ? Number(match[1]) : /^\d+$/.test(id) ? Number(id) : NaN;
  if (!Number.isFinite(numeric)) return undefined;
  for (const repo of allRepos()) {
    for (const pull of repo.pulls.values()) if (pull.id === numeric) return { repo, pull };
  }
  return undefined;
}

// ---------------------------------------------------------------- store helpers (same rules as REST)

/** The file map at a commit, or an empty map when it has none. */
function filesOf(repo: Repository, branch: string): Map<string, FileEntry> {
  const sha = forge.branchSha(repo, branch);
  return sha === undefined ? new Map() : forge.filesAt(sha);
}

/** Whether two branches changed the same path since their merge base (the REST merge rule). */
function branchesConflict(repo: Repository, headSha: string, baseSha: string): boolean {
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

/** The paths a pull request changes: the merge base's files against its head's. */
function pullPaths(repo: Repository, pull: PullRequest): string[] {
  const headSha = forge.branchSha(repo, pull.head);
  const baseSha = forge.branchSha(repo, pull.base);
  if (headSha === undefined) return [];
  const mergeBase = baseSha === undefined ? undefined : forge.mergeBase(headSha, baseSha);
  const before = mergeBase === undefined ? new Map<string, FileEntry>() : forge.filesAt(mergeBase);
  const after = forge.filesAt(headSha);
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const changed: string[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.sha === newEntry.sha) continue;
    changed.push(path);
  }
  return changed;
}

/** A pull request's GraphQL mergeable state, computed from the same branches REST merges. */
function mergeableState(repo: Repository, pull: PullRequest): string {
  if (pull.state !== 'open' || pull.merged) return 'UNKNOWN';
  const headSha = forge.branchSha(repo, pull.head);
  const baseSha = forge.branchSha(repo, pull.base);
  if (headSha === undefined || baseSha === undefined) return 'UNKNOWN';
  return branchesConflict(repo, headSha, baseSha) ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------- connections and cursors

/** A cursor is the index of the next item, base64url so the client treats it as opaque. */
function encodeCursor(index: number): string {
  return Buffer.from(`issue:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | undefined {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    if (match === null) return undefined;
    const index = Number(match[1]);
    return Number.isFinite(index) && index >= 0 ? index : undefined;
  } catch {
    return undefined;
  }
}

/** Sort issues GitHub's CREATED_AT DESC way: newest first, ties by the larger number. */
function sortIssues(items: Issue[], field: string, direction: string): Issue[] {
  const dir = direction.toUpperCase() === 'ASC' ? 1 : -1;
  const sorted = [...items];
  sorted.sort((a, b) => {
    let cmp: number;
    if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
    else cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    if (cmp === 0) cmp = a.number - b.number;
    return cmp * dir;
  });
  return sorted;
}

// ---------------------------------------------------------------- the schema

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'];
const PULL_FIELDS = [
  'id',
  'number',
  'title',
  'body',
  'state',
  'merged',
  'mergedAt',
  'headRefName',
  'baseRefName',
  'mergeable',
  'files',
  'createdAt',
  'updatedAt',
  'author',
  'commits',
];
const REPOSITORY_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'description',
  'isPrivate',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
  'ref',
  'object',
  'createdAt',
  'updatedAt',
];

/** The static schema `__type` reports: field names per type and enum values per enum. */
const SCHEMA: Record<string, { kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR'; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'user', 'search', 'rateLimit'] },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'deleteIssue'],
  },
  Repository: { kind: 'OBJECT', fields: REPOSITORY_FIELDS },
  Issue: { kind: 'OBJECT', fields: ISSUE_FIELDS },
  PullRequest: { kind: 'OBJECT', fields: PULL_FIELDS },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'avatarUrl', 'isViewer'] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge'] },
  CommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },

  IssueOrder: { kind: 'INPUT_OBJECT', fields: ['field', 'direction'] },
  CreateIssueInput: { kind: 'INPUT_OBJECT', fields: ['repositoryId', 'title', 'body', 'assigneeIds', 'labelIds'] },
  CloseIssueInput: { kind: 'INPUT_OBJECT', fields: ['issueId', 'stateReason'] },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT', fields: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'draft'] },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', fields: ['pullRequestId', 'mergeMethod', 'commitHeadline'] },
  AddCommentInput: { kind: 'INPUT_OBJECT', fields: ['subjectId', 'body'] },
};

// ---------------------------------------------------------------- resolvers

function userNode(login: string): GNode {
  return gnode('User', { login });
}

function issueNode(repo: Repository, issue: Issue): GNode {
  return gnode('Issue', { repo, issue });
}

function pullNode(repo: Repository, pull: PullRequest): GNode {
  return gnode('PullRequest', { repo, pull });
}

function pageInfo(hasNextPage: boolean, start: number, end: number, total: number): GNode {
  return gnode('PageInfo', { hasNextPage, hasPreviousPage: start > 0, startCursor: total === 0 ? null : encodeCursor(start), endCursor: total === 0 ? null : encodeCursor(end) });
}

const TYPES: Record<string, TypeDef> = {
  Query: {
    viewer: () => userNode(VIEWER_LOGIN),
    repository: (_parent, args) => {
      const owner = asString(args.owner);
      const name = asString(args.name);
      if (owner === '' || name === '') return null;
      if (owner.toLowerCase() !== VIEWER_LOGIN) return null;
      const repo = forge.repo(owner, name);
      return repo === undefined ? null : gnode('Repository', repo);
    },
    user: (_parent, args) => {
      const login = asString(args.login);
      if (login === '') return null;
      return userNode(login);
    },
    node: (_parent, args) => {
      const id = asString(args.id);
      if (id === '') return null;
      const repo = findRepoById(id);
      if (repo !== undefined) return gnode('Repository', repo);
      const issue = findIssueById(id);
      if (issue !== undefined) return issueNode(issue.repo, issue.issue);
      const pull = findPullById(id);
      if (pull !== undefined) return pullNode(pull.repo, pull.pull);
      return null;
    },
    __type: (_parent, args) => {
      const name = asString(args.name);
      return SCHEMA[name] === undefined ? null : gnode('__Type', { name });
    },
    rateLimit: () => gnode('RateLimit', { limit: 5000, remaining: 4999, used: 1 }),
    search: () => gnode('SearchResultItemConnection', { nodes: [] }),
  },
  Mutation: {
    createIssue: (_parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoById(asString(input.repositoryId));
      if (repo === undefined) throw new GqlError('Could not resolve to a Repository with the given id');
      const title = asString(input.title);
      if (title === '') throw new GqlError('A title is required to create an issue');
      const now = forge.clock.nextIso();
      const issue: Issue = {
        id: forge.issueId(),
        number: repo.nextIssueNumber,
        title,
        body: asString(input.body),
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
      return gnode('CreateIssuePayload', { repo, issue });
    },
    closeIssue: (_parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueById(asString(input.issueId));
      if (found === undefined) throw new GqlError('Could not resolve to an Issue with the given id');
      const issue = found.issue;
      issue.state = 'closed';
      issue.closedAt = forge.clock.nextIso();
      issue.updatedAt = issue.closedAt;
      found.repo.updatedAt = issue.closedAt;
      return gnode('CloseIssuePayload', { repo: found.repo, issue });
    },
    createPullRequest: (_parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoById(asString(input.repositoryId));
      if (repo === undefined) throw new GqlError('Could not resolve to a Repository with the given id');
      const head = asString(input.headRefName);
      const base = asString(input.baseRefName) || repo.defaultBranch;
      if (head === '') throw new GqlError('A headRefName is required to create a pull request');
      if (forge.branchSha(repo, head) === undefined) throw new GqlError(`No commits between ${base} and ${head}`);
      if (forge.branchSha(repo, base) === undefined) throw new GqlError(`Base branch ${base} does not exist`);
      const now = forge.clock.nextIso();
      const pull: PullRequest = {
        id: forge.pullId(),
        number: repo.nextPullNumber,
        title: asString(input.title) || `${head} into ${base}`,
        body: asString(input.body),
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
      return gnode('CreatePullRequestPayload', { repo, pull });
    },
    mergePullRequest: (_parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullById(asString(input.pullRequestId));
      if (found === undefined) throw new GqlError('Could not resolve to a PullRequest with the given id');
      const { repo, pull } = found;
      const headSha = forge.branchSha(repo, pull.head);
      const baseSha = forge.branchSha(repo, pull.base);
      if (headSha === undefined || baseSha === undefined) throw new GqlError('Pull request is not mergeable');
      if (pull.merged) throw new GqlError('Pull request is already merged');
      if (branchesConflict(repo, headSha, baseSha)) throw new GqlError('Pull request is not mergeable: merge conflict');
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
      return gnode('MergePullRequestPayload', { repo, pull });
    },
    addComment: (_parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueById(asString(input.subjectId));
      if (found === undefined) throw new GqlError('Could not resolve to an Issue or PullRequest with the given id');
      const body = asString(input.body);
      if (body === '') throw new GqlError('A body is required to add a comment');
      const comment = { id: forge.commentId(), body, user: VIEWER_LOGIN, createdAt: forge.clock.nextIso() };
      found.issue.comments.push(comment);
      found.issue.updatedAt = comment.createdAt;
      return gnode('AddCommentPayload', { repo: found.repo, comment });
    },
    updateIssue: () => gnode('UpdateIssuePayload', {}),
    deleteIssue: () => gnode('DeleteIssuePayload', {}),
  },
  Repository: {
    id: (parent) => repoGlobalId(parent as Repository),
    databaseId: (parent) => (parent as Repository).id,
    name: (parent) => (parent as Repository).name,
    nameWithOwner: (parent) => `${(parent as Repository).owner}/${(parent as Repository).name}`,
    owner: (parent) => userNode((parent as Repository).owner),
    description: (parent) => (parent as Repository).description,
    isPrivate: (parent) => (parent as Repository).private,
    defaultBranchRef: (parent) => {
      const repo = parent as Repository;
      return forge.branchSha(repo, repo.defaultBranch) === undefined ? null : gnode('Ref', { name: repo.defaultBranch });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (parent) => (parent as Repository).createdAt,
    updatedAt: (parent) => (parent as Repository).updatedAt,
    issue: (parent, args) => {
      const repo = parent as Repository;
      const number = asNumber(args.number);
      if (number === undefined) return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (parent, args) => {
      const repo = parent as Repository;
      const all = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map((value) => asString(value).toUpperCase()) : [];
      let items = all;
      if (states.length > 0) {
        items = items.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const orderBy = (args.orderBy ?? null) as Record<string, unknown> | null;
      const field = orderBy === null ? 'CREATED_AT' : asString(orderBy.field) || 'CREATED_AT';
      const direction = orderBy === null ? 'DESC' : asString(orderBy.direction) || 'DESC';
      const sorted = sortIssues(items, field, direction);
      const total = sorted.length;
      const first = Math.max(0, Math.min(asNumber(args.first) ?? 100, total));
      const after = typeof args.after === 'string' ? decodeCursor(args.after) : undefined;
      const start = after ?? 0;
      const slice = sorted.slice(start, start + first);
      const end = start + slice.length;
      return gnode('IssueConnection', {
        nodes: slice.map((issue) => issueNode(repo, issue)),
        hasNextPage: end < total,
        start,
        end: total === 0 ? 0 : end,
        total,
      });
    },
    pullRequests: (parent, args) => {
      const repo = parent as Repository;
      let items = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map((value) => asString(value).toUpperCase()) : [];
      if (states.length > 0) {
        items = items.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
      } else {
        items = items.filter((pull) => pull.state === 'open' && !pull.merged);
      }
      items.sort((a, b) => b.number - a.number);
      const first = Math.max(0, Math.min(asNumber(args.first) ?? 100, items.length));
      const slice = items.slice(0, first);
      return gnode('PullRequestConnection', { nodes: slice.map((pull) => pullNode(repo, pull)), total: items.length, first });
    },
    pullRequest: (parent, args) => {
      const repo = parent as Repository;
      const number = asNumber(args.number);
      if (number === undefined) return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullNode(repo, pull);
    },
    ref: (parent, args) => {
      const repo = parent as Repository;
      const name = asString(args.qualifiedName).replace(/^refs\/heads\//, '');
      if (name === '' || forge.branchSha(repo, name) === undefined) return null;
      return gnode('Ref', { name });
    },
    object: () => null,
  },
  Issue: {
    id: (parent) => issueGlobalId((parent as { issue: Issue }).issue),
    number: (parent) => (parent as { issue: Issue }).issue.number,
    title: (parent) => (parent as { issue: Issue }).issue.title,
    body: (parent) => (parent as { issue: Issue }).issue.body,
    state: (parent) => ((parent as { issue: Issue }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: (parent) => (parent as { issue: Issue }).issue.createdAt,
    updatedAt: (parent) => (parent as { issue: Issue }).issue.updatedAt,
    author: (parent) => userNode((parent as { issue: Issue }).issue.user),
    labels: (parent) => {
      const { repo, issue } = parent as { repo: Repository; issue: Issue };
      return gnode('LabelConnection', { nodes: issue.labels.map((name) => gnode('Label', repo.labels.get(name) ?? { name, color: 'ededed', description: '' })) });
    },
    comments: (parent) => {
      const { issue } = parent as { repo: Repository; issue: Issue };
      return gnode('IssueCommentConnection', {
        nodes: issue.comments.map((comment) => gnode('IssueComment', comment)),
        total: issue.comments.length,
        first: issue.comments.length,
      });
    },
  },
  PullRequest: {
    id: (parent) => pullGlobalId((parent as { pull: PullRequest }).pull),
    number: (parent) => (parent as { pull: PullRequest }).pull.number,
    title: (parent) => (parent as { pull: PullRequest }).pull.title,
    body: (parent) => (parent as { pull: PullRequest }).pull.body,
    state: (parent) => {
      const pull = (parent as { pull: PullRequest }).pull;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (parent) => (parent as { pull: PullRequest }).pull.merged,
    mergedAt: (parent) => (parent as { pull: PullRequest }).pull.mergedAt,
    headRefName: (parent) => (parent as { pull: PullRequest }).pull.head,
    baseRefName: (parent) => (parent as { pull: PullRequest }).pull.base,
    createdAt: (parent) => (parent as { pull: PullRequest }).pull.createdAt,
    updatedAt: (parent) => (parent as { pull: PullRequest }).pull.updatedAt,
    author: (parent) => userNode((parent as { pull: PullRequest }).pull.user),
    mergeable: (parent) => {
      const { repo, pull } = parent as { repo: Repository; pull: PullRequest };
      return mergeableState(repo, pull);
    },
    files: (parent, args) => {
      const { repo, pull } = parent as { repo: Repository; pull: PullRequest };
      const paths = pullPaths(repo, pull);
      const first = Math.max(0, Math.min(asNumber(args.first) ?? 100, paths.length));
      const slice = paths.slice(0, first);
      return gnode('PullRequestChangedFileConnection', {
        nodes: slice.map((path) => gnode('PullRequestChangedFile', { path })),
        total: paths.length,
        first,
      });
    },
    commits: () => gnode('PullRequestCommitConnection', { nodes: [] }),
  },
  User: {
    id: (parent) => `U_${(parent as { login: string }).login}`,
    login: (parent) => (parent as { login: string }).login,
    name: (parent) => (parent as { login: string }).login,
    email: (parent) => `${(parent as { login: string }).login}@example.invalid`,
    avatarUrl: () => 'https://avatars.githubusercontent.com/u/0',
    isViewer: (parent) => (parent as { login: string }).login === VIEWER_LOGIN,
  },
  Ref: {
    id: (parent) => `REF_${(parent as { name: string }).name}`,
    name: (parent) => (parent as { name: string }).name,
    prefix: () => 'refs/heads/',
    target: () => null,
  },
  // Connections share one shape: nodes, pageInfo and totalCount.
  IssueConnection: connectionFields('Issue'),
  PullRequestConnection: connectionFields('PullRequest'),
  PullRequestChangedFileConnection: connectionFields('PullRequestChangedFile'),
  IssueCommentConnection: connectionFields('IssueComment'),
  LabelConnection: connectionFields('Label'),
  SearchResultItemConnection: connectionFields('SearchResultItem'),
  PageInfo: {
    hasNextPage: (parent) => (parent as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (parent) => (parent as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (parent) => (parent as { startCursor: string | null }).startCursor,
    endCursor: (parent) => (parent as { endCursor: string | null }).endCursor,
  },
  PullRequestChangedFile: {
    path: (parent) => (parent as { path: string }).path,
    additions: () => 1,
    deletions: () => 0,
    changeType: () => 'MODIFIED',
  },
  IssueComment: {
    id: (parent) => commentGlobalId((parent as { id: number }).id),
    body: (parent) => (parent as { body: string }).body,
    author: (parent) => userNode((parent as { user: string }).user),
    createdAt: (parent) => (parent as { createdAt: string }).createdAt,
    updatedAt: (parent) => (parent as { createdAt: string }).createdAt,
  },
  Label: {
    id: (parent) => `L_${(parent as { name: string }).name}`,
    name: (parent) => (parent as { name: string }).name,
    color: (parent) => (parent as { color: string }).color,
    description: (parent) => (parent as { description: string }).description,
  },
  CreateIssuePayload: { issue: (parent) => issueNode((parent as { repo: Repository; issue: Issue }).repo, (parent as { issue: Issue }).issue) },
  CloseIssuePayload: { issue: (parent) => issueNode((parent as { repo: Repository; issue: Issue }).repo, (parent as { issue: Issue }).issue) },
  CreatePullRequestPayload: { pullRequest: (parent) => pullNode((parent as { repo: Repository; pull: PullRequest }).repo, (parent as { repo: Repository; pull: PullRequest }).pull) },
  MergePullRequestPayload: { pullRequest: (parent) => pullNode((parent as { repo: Repository; pull: PullRequest }).repo, (parent as { repo: Repository; pull: PullRequest }).pull) },
  AddCommentPayload: {
    commentEdge: (parent) => gnode('CommentEdge', { comment: (parent as { comment: { id: number } }).comment }),
  },
  CommentEdge: {
    cursor: () => '',
    node: (parent) => gnode('IssueComment', (parent as { comment: unknown }).comment),
  },
  __Type: {
    name: (parent) => (parent as { name: string }).name,
    kind: (parent) => SCHEMA[(parent as { name: string }).name]?.kind ?? 'OBJECT',
    description: () => null,
    fields: (parent, args) => {
      const name = (parent as { name: string }).name;
      const def = SCHEMA[name];
      if (def === undefined || def.fields === undefined) return [];
      const includeDeprecated = args.includeDeprecated === true;
      return def.fields.map((fieldName) => gnode('__Field', { name: fieldName, includeDeprecated }));
    },
    enumValues: (parent) => {
      const def = SCHEMA[(parent as { name: string }).name];
      if (def === undefined || def.enumValues === undefined) return [];
      return def.enumValues.map((value) => gnode('__EnumValue', { name: value }));
    },
    inputFields: (parent) => {
      const def = SCHEMA[(parent as { name: string }).name];
      if (def === undefined || def.fields === undefined) return [];
      return def.fields.map((fieldName) => gnode('__InputValue', { name: fieldName }));
    },
  },
  __Field: {
    name: (parent) => (parent as { name: string }).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
    args: () => [],
    type: () => gnode('__TypeRef', {}),
  },
  __EnumValue: {
    name: (parent) => (parent as { name: string }).name,
    description: () => null,
    isDeprecated: () => false,
  },
  __InputValue: {
    name: (parent) => (parent as { name: string }).name,
    description: () => null,
    defaultValue: () => null,
  },
  __TypeRef: { name: () => null, kind: () => 'SCALAR', ofType: () => null },
  RateLimit: { limit: (p) => (p as { limit: number }).limit, remaining: (p) => (p as { remaining: number }).remaining, used: (p) => (p as { used: number }).used },
};

/** The four fields every connection answers, from the shape its resolvers produce. */
function connectionFields(typeName: string): TypeDef {
  return {
    nodes: (parent) => (parent as { nodes: unknown[] }).nodes,
    edges: (parent) => {
      const nodes = (parent as { nodes: unknown[] }).nodes;
      return nodes.map((node) => gnode('Edge', { node }));
    },
    totalCount: (parent) => (parent as { total: number }).total,
    pageInfo: (parent) => {
      const shaped = parent as { hasNextPage?: boolean; start?: number; end?: number; total?: number; nodes: unknown[] };
      const total = shaped.total ?? shaped.nodes.length;
      return pageInfo(shaped.hasNextPage ?? false, shaped.start ?? 0, shaped.end ?? total, total);
    },
    __typename: () => typeName,
  };
}

// ---------------------------------------------------------------- the evaluator

/** Whether a fragment's type condition applies to a runtime type. */
function applies(runtimeType: string, condition: string | undefined): boolean {
  if (condition === undefined) return true;
  if (condition === runtimeType) return true;
  if (condition === 'Node') return true;
  return false;
}

/** Execute one selection set against one node, merging inline fragments and spreads. */
function executeSelection(
  node: GNode | null,
  selection: SelNode[],
  fragments: Map<string, { typeCondition: string; selection: SelNode[] }>,
  variables: Record<string, unknown>,
): unknown {
  if (node === null) return null;
  const out: Record<string, unknown> = {};
  for (const entry of selection) {
    if (entry.kind === 'field') executeField(node, entry, fragments, variables, out);
    else if (entry.kind === 'inline') {
      if (applies(node.__t, entry.typeCondition)) {
        const nested = executeSelection(node, entry.selection, fragments, variables);
        if (nested !== null && typeof nested === 'object') Object.assign(out, nested as Record<string, unknown>);
      }
    } else {
      const fragment = fragments.get(entry.name);
      if (fragment === undefined) throw new GqlError(`Unknown fragment "${entry.name}"`);
      if (applies(node.__t, fragment.typeCondition)) {
        const nested = executeSelection(node, fragment.selection, fragments, variables);
        if (nested !== null && typeof nested === 'object') Object.assign(out, nested as Record<string, unknown>);
      }
    }
  }
  return out;
}

function executeField(
  node: GNode,
  field: { alias: string | undefined; name: string; args: ArgMap; selection: SelNode[] },
  fragments: Map<string, { typeCondition: string; selection: SelNode[] }>,
  variables: Record<string, unknown>,
  out: Record<string, unknown>,
): void {
  const key = field.alias ?? field.name;
  if (field.name === '__typename') {
    out[key] = node.__t;
    return;
  }
  const def = TYPES[node.__t];
  const resolver = def?.[field.name];
  if (resolver === undefined) {
    throw new GqlError(`Cannot query field "${field.name}" on type "${node.__t}".`);
  }
  const args = evalArgs(field.args, variables);
  let value: unknown;
  try {
    value = resolver(node.v, args);
  } catch (err) {
    throw err instanceof GqlError ? err : new GqlError(err instanceof Error ? err.message : String(err));
  }
  out[key] = resolveValue(value, field.selection, fragments, variables);
}

/** Resolve a resolver's answer: a node gets its selection, an array is mapped, a scalar passes through. */
function resolveValue(
  value: unknown,
  selection: SelNode[],
  fragments: Map<string, { typeCondition: string; selection: SelNode[] }>,
  variables: Record<string, unknown>,
): unknown {
  if (value === null || value === undefined) return null;
  if (isNode(value)) {
    if (selection.length === 0) return null;
    return executeSelection(value, selection, fragments, variables);
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, selection, fragments, variables));
  return value;
}

// ---------------------------------------------------------------- the document runner

interface OperationResult {
  data?: unknown;
  errors?: { message: string; path?: (string | number)[] }[];
}

/** Run one {query, variables} operation and answer its {data, errors} envelope. */
function runOperation(body: Record<string, unknown>): OperationResult {
  const query = typeof body.query === 'string' ? body.query : '';
  if (query.trim() === '') return { errors: [{ message: 'A query document is required' }] };
  const variables = body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables)
    ? (body.variables as Record<string, unknown>)
    : {};
  let document: ParsedDocument;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const requestedName = typeof body.operationName === 'string' ? body.operationName : undefined;
  const operation =
    requestedName === undefined
      ? document.operations[0]
      : document.operations.find((candidate) => candidate.name === requestedName);
  if (operation === undefined) {
    return { errors: [{ message: `Unknown operation${requestedName === undefined ? '' : ` "${requestedName}"`}` }] };
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = executeSelection(gnode(rootType, null), operation.selection, document.fragments, variables);
    return { data: data ?? {} };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { errors: [{ message }] };
  }
}

// ---------------------------------------------------------------- the route

/** Read the request body: an object is one operation, a JSON array is a batch. */
async function readGraphqlBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  if (raw.length === 0) throw new GqlError('A GraphQL request needs a JSON body');
  let text: string;
  try {
    text = raw.toString('utf8');
  } catch {
    throw new GqlError('The request body is not utf-8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GqlError('Problems parsing JSON');
  }
}

/** Answer POST /api/graphql. An unauthenticated call is 401; everything else is a 200 envelope. */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const token = bearerOf(req);
  if (token === null || token === '' || (TOKEN !== '' && token !== TOKEN)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let body: unknown;
  try {
    body = await readGraphqlBody(req);
  } catch (err) {
    sendJson(res, 200, { errors: [{ message: err instanceof Error ? err.message : String(err) }] });
    return;
  }
  if (Array.isArray(body)) {
    const responses = body.map((entry) =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? runOperation(entry as Record<string, unknown>)
        : { errors: [{ message: 'Each batched operation must be a JSON object' }] },
    );
    sendJson(res, 200, responses);
    return;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(res, 200, { errors: [{ message: 'The request body must be a JSON object or an array' }] });
    return;
  }
  sendJson(res, 200, runOperation(body as Record<string, unknown>));
}
