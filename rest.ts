// The GitHub REST v3 surface: repositories, branches, commits, contents, labels, issues and
// pull requests. Every route answers JSON with the request-id header; an unknown route is a JSON
// 404; an unparsable body is a 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BodyError,
  bearerOf,
  decodeBase64,
  encodeBase64Wrapped,
  errorBody,
  originOf,
  parseUrl,
  readJson,
  sendJson,
  stringField,
} from './http.ts';
import {
  Forge,
  VIEWER_EMAIL,
  VIEWER_LOGIN,
  VIEWER_NAME,
  buildTreeFromFiles,
  forge,
  isoOf,
} from './store.ts';
import type { CommitInfo, FileEntry, Issue, Label, PullRequest, Repository } from './store.ts';

/** The bearer token every API call must carry, from the trial's environment. */
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** The scopes the API root advertises. */
const SCOPES = 'repo, read:org';
/** The version the meta route reports. */
const INSTALLED_VERSION = 'forge-1.0.0';

/** A request whose caller may not proceed: the router answers it. */
export class ApiError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------- shapes

/** The user object the API answers with. */
function userJson(login: string): Record<string, unknown> {
  const isViewer = login === VIEWER_LOGIN;
  return {
    login,
    id: isViewer ? 1000 : 1002,
    node_id: `U_${login}`,
    type: 'User',
    site_admin: false,
    name: isViewer ? VIEWER_NAME : login,
    email: isViewer ? VIEWER_EMAIL : `${login}@example.invalid`,
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
  };
}

/** The repository object, in GitHub's field names. */
function repoJson(repo: Repository): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    fork: repo.fork,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    visibility: repo.private ? 'private' : 'public',
  };
}

/** A label object. */
function labelJson(label: Label): Record<string, unknown> {
  return { id: label.name.length + label.color.length, name: label.name, color: label.color, description: label.description, default: label.default };
}

/** The label names an issue carries, as GitHub's array of objects. */
function issueLabels(repo: Repository, issue: Issue): Record<string, unknown>[] {
  return issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: '', default: false }));
}

/** An issue object. */
function issueJson(repo: Repository, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    labels: issueLabels(repo, issue),
    user: userJson(issue.user),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** A comment object. */
function commentJson(comment: { id: number; body: string; user: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

/** The head/base ref pair a pull request reports. */
function refPair(repo: Repository, branch: string): Record<string, unknown> {
  const sha = forge.branchSha(repo, branch) ?? '';
  return { ref: branch, sha, label: `${repo.owner}:${branch}`, user: userJson(repo.owner), repo: repoJson(repo) };
}

/** A pull request object. */
function pullJson(repo: Repository, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `P_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: userJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_by: pull.mergedBy === null ? null : userJson(pull.mergedBy),
    head: refPair(repo, pull.head),
    base: refPair(repo, pull.base),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    draft: false,
    mergeable: pull.state === 'open',
  };
}

/** A commit object as the REST API lists it. */
function commitJson(sha: string, info: CommitInfo): Record<string, unknown> {
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message: info.message,
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoOf(info.authorSec) },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoOf(info.committerSec) },
      tree: { sha: info.tree },
    },
    author: userJson(VIEWER_LOGIN),
    committer: userJson(VIEWER_LOGIN),
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------- helpers

/** The token gate: a missing or wrong bearer token is a 401. */
function authorize(req: IncomingMessage): void {
  const token = bearerOf(req);
  if (token === null || token === '') throw new ApiError(401, 'Requires authentication');
  if (TOKEN !== '' && token !== TOKEN) throw new ApiError(401, 'Bad credentials');
}

/** Look a repository up, or 404. An owner that is not this token's login is never found. */
function repoOr404(owner: string, name: string): Repository {
  if (owner.toLowerCase() !== VIEWER_LOGIN) throw new ApiError(404, 'Not Found');
  const repo = forge.repo(owner, name);
  if (repo === undefined) throw new ApiError(404, 'Not Found');
  return repo;
}

/** A branch tip, or 404. */
function branchTip(repo: Repository, branch: string): string {
  const sha = forge.branchSha(repo, branch);
  if (sha === undefined) throw new ApiError(404, 'Not Found');
  return sha;
}

/** The refs under a repository as `refs/heads/<name>` -> sha. */
function branchList(repo: Repository): { name: string; sha: string }[] {
  const out: { name: string; sha: string }[] = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** The commits reachable from a tip, newest first. */
function commitList(repo: Repository, tip: string): { sha: string; info: CommitInfo }[] {
  const out: { sha: string; info: CommitInfo }[] = [];
  for (const sha of forge.ancestors(tip)) {
    const info = forge.commit(sha);
    if (info !== undefined) out.push({ sha, info });
  }
  return out;
}

/** Commit a new file map onto a branch, moving the ref. */
function commitToBranch(repo: Repository, branch: string, files: Map<string, FileEntry>, message: string): string {
  const tip = forge.branchSha(repo, branch);
  const parents = tip === undefined ? [] : [tip];
  const sha = forge.commitFiles(files, parents, message);
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updatedAt = forge.clock.nextIso();
  return sha;
}

/** The file map at a ref, or an empty map for an unborn branch. */
function filesAtRef(repo: Repository, ref: string | undefined): Map<string, FileEntry> {
  const branch = ref === undefined || ref === '' ? repo.defaultBranch : ref;
  const sha = forge.branchSha(repo, branch);
  if (sha === undefined) return new Map();
  return forge.filesAt(sha);
}

/** Parse a positive integer query parameter, with a default and a ceiling. */
function intParam(query: URLSearchParams, key: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = query.get(key);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(value, max);
}

/** The page of a list, plus the Link header when another page follows. */
function paginate<T>(
  req: IncomingMessage,
  items: readonly T[],
  query: URLSearchParams,
  path: string,
): { page: T[]; link: string | null } {
  const perPage = intParam(query, 'per_page', 30, 100);
  const pageNo = intParam(query, 'page', 1);
  const start = (pageNo - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const origin = originOf(req);
  const urlFor = (target: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `${origin}${path}?${params.toString()}`;
  };
  if (pageNo < lastPage) links.push(`<${urlFor(pageNo + 1)}>; rel="next"`);
  if (pageNo > 1) links.push(`<${urlFor(pageNo - 1)}>; rel="prev"`);
  links.push(`<${urlFor(lastPage)}>; rel="last"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  return { page, link: links.join(', ') };
}

/** The path segments of a request, decoded, with `/api/v3` removed. */
function segmentsOf(path: string): string[] {
  const parts = path.split('/').filter((part) => part !== '');
  const out: string[] = [];
  for (const part of parts) {
    try {
      out.push(decodeURIComponent(part));
    } catch {
      out.push(part);
    }
  }
  return out;
}

/** A file's contents as the contents API answers it. */
function fileJson(repo: Repository, path: string, entry: FileEntry): Record<string, unknown> {
  const data = forge.objects.blobData(entry.sha) ?? Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    sha: entry.sha,
    content: encodeBase64Wrapped(data),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
  };
}

/** Every file under a directory path, with the directory prefix stripped. */
function subtree(files: ReadonlyMap<string, FileEntry>, dir: string): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  const prefix = `${dir}/`;
  for (const [path, entry] of files) {
    if (path.startsWith(prefix)) out.set(path.slice(prefix.length), entry);
  }
  return out;
}

/** The directory listing the contents API answers for a directory. */
function directoryJson(repo: Repository, files: ReadonlyMap<string, FileEntry>, dir: string): Record<string, unknown>[] {
  const prefix = `${dir}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; sha: string }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      entries.set(rest, { type: 'file', sha: entry.sha });
    } else {
      const name = rest.slice(0, slash);
      if (!entries.has(name)) entries.set(name, { type: 'dir', sha: '' });
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const [name, info] of entries) {
    let sha = info.sha;
    if (info.type === 'dir') {
      sha = buildTreeFromFiles(forge.objects, subtree(files, `${dir}/${name}`));
    }
    out.push({
      type: info.type,
      name,
      path: `${dir}/${name}`,
      sha,
      size: 0,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${dir}/${name}`,
    });
  }
  out.sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0));
  return out;
}

/** The lines of a blob, for the pull-file change counts. */
function lineCount(sha: string): number {
  const data = forge.objects.blobData(sha);
  if (data === null || data.length === 0) return 0;
  return data.toString('utf8').split('\n').length;
}

/** The files a pull request changed, with GitHub's status and change counts. */
function pullFiles(repo: Repository, pull: PullRequest): Record<string, unknown>[] {
  const headSha = forge.branchSha(repo, pull.head);
  const baseSha = forge.branchSha(repo, pull.base);
  if (headSha === undefined || baseSha === undefined) return [];
  const mergeBase = forge.mergeBase(headSha, baseSha) ?? baseSha;
  const before = forge.filesAt(mergeBase);
  const after = forge.filesAt(headSha);
  const out: Record<string, unknown>[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.sha === newEntry.sha) continue;
    const status = oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified';
    const additions = newEntry === undefined ? 0 : Math.max(1, lineCount(newEntry.sha));
    const deletions = oldEntry === undefined ? 0 : Math.max(1, lineCount(oldEntry.sha));
    out.push({
      sha: newEntry?.sha ?? oldEntry?.sha ?? '',
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `/api/v3/repos/${repo.owner}/${repo.name}/blob/${pull.head}/${path}`,
    });
  }
  return out;
}

/** Whether merging head into base would conflict: both sides changed one path differently. */
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

// ---------------------------------------------------------------- route handlers

function listRepos(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
  const mine = [...forge.repos.values()].filter((repo) => repo.owner.toLowerCase() === VIEWER_LOGIN);
  mine.sort((a, b) => a.id - b.id);
  const { page, link } = paginate(req, mine, query, '/api/v3/user/repos');
  sendJson(res, 200, page.map(repoJson), link === null ? {} : { link });
}

async function createRepo(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const name = stringField(body, 'name').trim();
  if (name === '') throw new ApiError(422, 'Repository name is required');
  if (forge.repo(VIEWER_LOGIN, name) !== undefined) throw new ApiError(422, 'Repository creation failed', { errors: [{ resource: 'Repository', code: 'custom', message: 'name already exists on this account' }] });
  const repo = forge.createRepo(VIEWER_LOGIN, name, {
    description: stringField(body, 'description'),
    private: body.private === true,
    defaultBranch: stringField(body, 'default_branch') || 'main',
  });
  sendJson(res, 201, repoJson(repo));
}

function getRepo(res: ServerResponse, repo: Repository): void {
  sendJson(res, 200, repoJson(repo));
}

async function patchRepo(req: IncomingMessage, res: ServerResponse, repo: Repository): Promise<void> {
  const body = await readJson(req);
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
    const next = body.name.trim();
    if (forge.repo(VIEWER_LOGIN, next) !== undefined) throw new ApiError(422, 'Repository name already exists');
    forge.repos.delete(Forge.key(repo.owner, repo.name));
    repo.name = next;
    forge.repos.set(Forge.key(repo.owner, repo.name), repo);
  }
  if (typeof body.private === 'boolean') repo.private = body.private;
  if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
  repo.updatedAt = forge.clock.nextIso();
  sendJson(res, 200, repoJson(repo));
}

function listBranches(res: ServerResponse, repo: Repository): void {
  sendJson(
    res,
    200,
    branchList(repo).map((branch) => ({
      name: branch.name,
      commit: { sha: branch.sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${branch.sha}` },
      protected: false,
    })),
  );
}

async function createRef(req: IncomingMessage, res: ServerResponse, repo: Repository): Promise<void> {
  const body = await readJson(req);
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  if (!ref.startsWith('refs/')) throw new ApiError(422, 'Reference name must start with refs/');
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new ApiError(422, 'Object does not exist');
  if (forge.objects.get(sha) === undefined) throw new ApiError(422, 'Object does not exist');
  if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
  repo.refs.set(ref, sha.toLowerCase());
  repo.updatedAt = forge.clock.nextIso();
  sendJson(res, 201, { ref, node_id: `MDM6UmVm${ref}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}`, object: { sha: sha.toLowerCase(), type: 'commit' } });
}

function listCommits(res: ServerResponse, repo: Repository, query: URLSearchParams): void {
  const sha = query.get('sha');
  let tip: string | undefined;
  if (sha === null || sha === '') {
    tip = forge.branchSha(repo, repo.defaultBranch);
    if (tip === undefined) {
      sendJson(res, 200, []);
      return;
    }
  } else if (/^[0-9a-f]{40}$/i.test(sha)) {
    tip = sha.toLowerCase();
    if (forge.commit(tip) === undefined) throw new ApiError(404, 'Not Found');
  } else {
    tip = forge.branchSha(repo, sha);
    if (tip === undefined) throw new ApiError(404, 'Not Found');
  }
  const perPage = intParam(query, 'per_page', 30, 100);
  sendJson(res, 200, commitList(repo, tip).slice(0, perPage).map((entry) => commitJson(entry.sha, entry.info)));
}

function getContents(res: ServerResponse, repo: Repository, path: string, query: URLSearchParams): void {
  const ref = query.get('ref') ?? undefined;
  const clean = path.replace(/^\/+|\/+$/g, '');
  const files = filesAtRef(repo, ref);
  const entry = files.get(clean);
  if (entry !== undefined) {
    sendJson(res, 200, fileJson(repo, clean, entry));
    return;
  }
  const prefix = `${clean}/`;
  const hasUnder = [...files.keys()].some((candidate) => candidate.startsWith(prefix));
  if (!hasUnder) throw new ApiError(404, 'Not Found');
  sendJson(res, 200, directoryJson(repo, files, clean));
}

async function putContents(req: IncomingMessage, res: ServerResponse, repo: Repository, path: string): Promise<void> {
  const body = await readJson(req);
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') throw new ApiError(422, 'Path is required');
  const branch = stringField(body, 'branch') || repo.defaultBranch;
  const message = stringField(body, 'message') || `Create ${clean}`;
  const encoded = stringField(body, 'content');
  if (encoded === '') throw new ApiError(422, 'content is required');
  const data = decodeBase64(encoded);
  const files = filesAtRef(repo, branch);
  const existing = files.get(clean);
  const providedSha = stringField(body, 'sha');
  if (providedSha !== '') {
    if (existing === undefined) throw new ApiError(404, 'Not Found');
    if (existing.sha !== providedSha.toLowerCase()) {
      throw new ApiError(409, 'sha does not match the current file contents', { status: '409' });
    }
  }
  const entry = forge.setFile(files, clean, data);
  const commitSha = commitToBranch(repo, branch, files, message);
  sendJson(res, existing === undefined ? 201 : 200, {
    content: { name: clean.slice(clean.lastIndexOf('/') + 1), path: clean, sha: entry.sha, size: data.length, encoding: 'base64', type: 'file' },
    commit: { sha: commitSha, message, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${commitSha}` },
  });
}

async function deleteContents(req: IncomingMessage, res: ServerResponse, repo: Repository, path: string): Promise<void> {
  const body = await readJson(req);
  const clean = path.replace(/^\/+|\/+$/g, '');
  const branch = stringField(body, 'branch') || repo.defaultBranch;
  const message = stringField(body, 'message') || `Delete ${clean}`;
  const files = filesAtRef(repo, branch);
  const existing = files.get(clean);
  if (existing === undefined) throw new ApiError(404, 'Not Found');
  const providedSha = stringField(body, 'sha');
  if (providedSha !== '' && providedSha.toLowerCase() !== existing.sha) throw new ApiError(409, 'sha does not match the current file contents');
  files.delete(clean);
  const commitSha = commitToBranch(repo, branch, files, message);
  sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
}

async function createLabel(req: IncomingMessage, res: ServerResponse, repo: Repository): Promise<void> {
  const body = await readJson(req);
  const name = stringField(body, 'name').trim();
  if (name === '') throw new ApiError(422, 'name is required');
  const label: Label = {
    name,
    color: stringField(body, 'color') || 'ededed',
    description: stringField(body, 'description'),
    default: false,
  };
  repo.labels.set(name, label);
  sendJson(res, 201, labelJson(label));
}

function listLabels(res: ServerResponse, repo: Repository): void {
  sendJson(res, 200, [...repo.labels.values()].map(labelJson));
}

async function createIssue(req: IncomingMessage, res: ServerResponse, repo: Repository): Promise<void> {
  const body = await readJson(req);
  const title = stringField(body, 'title');
  if (title === '') throw new ApiError(422, 'title is required');
  const labelNames = Array.isArray(body.labels) ? body.labels.filter((item): item is string => typeof item === 'string') : [];
  for (const name of labelNames) {
    if (!repo.labels.has(name)) throw new ApiError(422, `Label does not exist: ${name}`);
  }
  const now = forge.clock.nextIso();
  const issue: Issue = {
    id: forge.issueId(),
    number: repo.nextIssueNumber,
    title,
    body: stringField(body, 'body'),
    state: 'open',
    labels: [...labelNames],
    user: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.nextIssueNumber += 1;
  repo.issues.set(issue.number, issue);
  repo.updatedAt = now;
  sendJson(res, 201, issueJson(repo, issue));
}

function listIssues(res: ServerResponse, repo: Repository, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = (query.get('direction') ?? 'desc').toLowerCase();
  let items = [...repo.issues.values()];
  if (state !== 'all') items = items.filter((issue) => issue.state === state);
  if (sort === 'created' || sort === 'updated') {
    items.sort((a, b) => a.number - b.number);
    if (direction !== 'asc') items.reverse();
  } else if (sort === 'comments') {
    items.sort((a, b) => a.comments.length - b.comments.length);
  }
  const perPage = intParam(query, 'per_page', 30, 100);
  sendJson(res, 200, items.slice(0, perPage).map((issue) => issueJson(repo, issue)));
}

function issueOr404(repo: Repository, number: number): Issue {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new ApiError(404, 'Not Found');
  return issue;
}

function getIssue(res: ServerResponse, repo: Repository, number: number): void {
  sendJson(res, 200, issueJson(repo, issueOr404(repo, number)));
}

async function patchIssue(req: IncomingMessage, res: ServerResponse, repo: Repository, number: number): Promise<void> {
  const issue = issueOr404(repo, number);
  const body = await readJson(req);
  if (typeof body.title === 'string' && body.title !== '') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? forge.clock.nextIso() : null;
  }
  if (Array.isArray(body.labels)) {
    const names = body.labels.filter((item): item is string => typeof item === 'string');
    for (const name of names) if (!repo.labels.has(name)) throw new ApiError(422, `Label does not exist: ${name}`);
    issue.labels = [...names];
  }
  issue.updatedAt = forge.clock.nextIso();
  sendJson(res, 200, issueJson(repo, issue));
}

async function createComment(req: IncomingMessage, res: ServerResponse, repo: Repository, number: number): Promise<void> {
  const issue = issueOr404(repo, number);
  const body = await readJson(req);
  const text = stringField(body, 'body');
  if (text === '') throw new ApiError(422, 'body is required');
  const comment = { id: forge.commentId(), body: text, user: VIEWER_LOGIN, createdAt: forge.clock.nextIso() };
  issue.comments.push(comment);
  issue.updatedAt = comment.createdAt;
  sendJson(res, 201, commentJson(comment));
}

function listComments(res: ServerResponse, repo: Repository, number: number): void {
  const issue = issueOr404(repo, number);
  sendJson(res, 200, issue.comments.map(commentJson));
}

async function createPull(req: IncomingMessage, res: ServerResponse, repo: Repository): Promise<void> {
  const body = await readJson(req);
  const head = stringField(body, 'head');
  const base = stringField(body, 'base') || repo.defaultBranch;
  const title = stringField(body, 'title');
  if (head === '') throw new ApiError(422, 'head is required');
  if (forge.branchSha(repo, head) === undefined) throw new ApiError(422, 'No commits between the base and the head');
  if (forge.branchSha(repo, base) === undefined) throw new ApiError(422, `Base branch ${base} does not exist`);
  const now = forge.clock.nextIso();
  const pull: PullRequest = {
    id: forge.pullId(),
    number: repo.nextPullNumber,
    title: title === '' ? `${head} into ${base}` : title,
    body: stringField(body, 'body'),
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
  sendJson(res, 201, pullJson(repo, pull));
}

function listPulls(res: ServerResponse, repo: Repository, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  let items = [...repo.pulls.values()];
  if (state !== 'all') items = items.filter((pull) => pull.state === state);
  items.sort((a, b) => a.number - b.number);
  const perPage = intParam(query, 'per_page', 30, 100);
  sendJson(res, 200, items.slice(0, perPage).map((pull) => pullJson(repo, pull)));
}

function pullOr404(repo: Repository, number: number): PullRequest {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new ApiError(404, 'Not Found');
  return pull;
}

function getPull(res: ServerResponse, repo: Repository, number: number): void {
  sendJson(res, 200, pullJson(repo, pullOr404(repo, number)));
}

function getPullFiles(res: ServerResponse, repo: Repository, number: number): void {
  const pull = pullOr404(repo, number);
  sendJson(res, 200, pullFiles(repo, pull));
}

async function mergePull(req: IncomingMessage, res: ServerResponse, repo: Repository, number: number): Promise<void> {
  const pull = pullOr404(repo, number);
  await readJson(req);
  const headSha = forge.branchSha(repo, pull.head);
  const baseSha = forge.branchSha(repo, pull.base);
  if (headSha === undefined || baseSha === undefined) throw new ApiError(405, 'Pull request is not mergeable');
  if (pull.merged) throw new ApiError(405, 'Pull request is not mergeable');
  if (hasConflict(repo, headSha, baseSha)) throw new ApiError(405, 'Pull request is not mergeable: merge conflict');
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
  sendJson(res, 200, { sha: mergeSha, merged: true, message: `Pull request #${pull.number} merged` });
}

// ---------------------------------------------------------------- the router

/** Whether a path belongs to the REST surface. */
export function isRestPath(path: string): boolean {
  return path === '/api/v3' || path.startsWith('/api/v3/');
}

/**
 * Answer one REST request. Returns true when the path was this surface's, so the caller stops;
 * a thrown ApiError has already been turned into a reply by `runRest`.
 */
export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const { path, query } = parseUrl(req);
  if (!isRestPath(path)) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const parts = segmentsOf(path).slice(2); // drop 'api' and 'v3'

  if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) {
    if (method !== 'GET') {
      sendJson(res, 404, errorBody('Not Found'));
      return true;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user', current_user_authorizations_html_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': SCOPES });
    return true;
  }

  if (parts[0] === 'meta' && parts.length === 1) {
    sendJson(res, 200, { installed_version: INSTALLED_VERSION, verifiable_password_authentication: false, hooks: [], git: [], ssh_keys: [] });
    return true;
  }

  authorize(req);

  if (parts[0] === 'user' && parts.length === 1) {
    sendJson(res, 200, userJson(VIEWER_LOGIN));
    return true;
  }
  if (parts[0] === 'rate_limit' && parts.length === 1) {
    sendJson(res, 200, { rate: { limit: 5000, remaining: 4999, reset: 1_767_225_600, used: 1 }, resources: {} });
    return true;
  }

  if (parts[0] === 'user' && parts[1] === 'repos' && parts.length === 2) {
    if (method === 'GET') listRepos(req, res, query);
    else if (method === 'POST') await createRepo(req, res);
    else throw new ApiError(404, 'Not Found');
    return true;
  }

  if (parts[0] === 'repos' && parts.length >= 3) {
    const owner = parts[1] as string;
    const name = parts[2] as string;
    const repo = repoOr404(owner, name);
    const rest = parts.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') getRepo(res, repo);
      else if (method === 'PATCH') await patchRepo(req, res, repo);
      else if (method === 'DELETE') {
        forge.deleteRepo(repo.owner, repo.name);
        res.writeHead(204, { 'x-github-request-id': String(res.getHeader('x-github-request-id') ?? '') });
        res.end();
      } else throw new ApiError(404, 'Not Found');
      return true;
    }

    if (rest[0] === 'branches' && rest.length === 1) {
      if (method !== 'GET') throw new ApiError(404, 'Not Found');
      listBranches(res, repo);
      return true;
    }

    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') throw new ApiError(404, 'Not Found');
      listCommits(res, repo, query);
      return true;
    }

    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) {
      if (method === 'POST') await createRef(req, res, repo);
      else throw new ApiError(404, 'Not Found');
      return true;
    }

    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'POST') await createLabel(req, res, repo);
      else if (method === 'GET') listLabels(res, repo);
      else throw new ApiError(404, 'Not Found');
      return true;
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') await createIssue(req, res, repo);
        else if (method === 'GET') listIssues(res, repo, query);
        else throw new ApiError(404, 'Not Found');
        return true;
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isFinite(number)) throw new ApiError(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') getIssue(res, repo, number);
        else if (method === 'PATCH') await patchIssue(req, res, repo, number);
        else throw new ApiError(404, 'Not Found');
        return true;
      }
      if (rest[2] === 'comments' && rest.length === 3) {
        if (method === 'POST') await createComment(req, res, repo, number);
        else if (method === 'GET') listComments(res, repo, number);
        else throw new ApiError(404, 'Not Found');
        return true;
      }
      throw new ApiError(404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') await createPull(req, res, repo);
        else if (method === 'GET') listPulls(res, repo, query);
        else throw new ApiError(404, 'Not Found');
        return true;
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isFinite(number)) throw new ApiError(404, 'Not Found');
      if (rest.length === 2) {
        if (method !== 'GET') throw new ApiError(404, 'Not Found');
        getPull(res, repo, number);
        return true;
      }
      if (rest[2] === 'files' && rest.length === 3) {
        if (method !== 'GET') throw new ApiError(404, 'Not Found');
        getPullFiles(res, repo, number);
        return true;
      }
      if (rest[2] === 'merge' && rest.length === 3) {
        if (method !== 'PUT') throw new ApiError(404, 'Not Found');
        await mergePull(req, res, repo, number);
        return true;
      }
      throw new ApiError(404, 'Not Found');
    }

    if (rest[0] === 'contents' && rest.length >= 2) {
      const path = rest.slice(1).join('/');
      if (method === 'GET') getContents(res, repo, path, query);
      else if (method === 'PUT') await putContents(req, res, repo, path);
      else if (method === 'DELETE') await deleteContents(req, res, repo, path);
      else throw new ApiError(404, 'Not Found');
      return true;
    }
  }

  throw new ApiError(404, 'Not Found');
}

/** Run a REST route, turning body and API errors into the reply GitHub would send. */
export async function runRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    return await handleRest(req, res);
  } catch (err) {
    if (err instanceof BodyError) {
      sendJson(res, 400, errorBody('Problems parsing JSON'));
      return true;
    }
    if (err instanceof ApiError) {
      sendJson(res, err.status, errorBody(err.message, err.extra));
      return true;
    }
    throw err;
  }
}
