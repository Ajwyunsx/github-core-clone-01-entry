// The forge's store: a real git object database (blobs, trees, commits, tags) plus the
// GitHub-shaped resources (repositories, labels, issues, pull requests) that sit on top of it.
//
// Everything here is deterministic: no Date.now, no Math.random, no port or host in any stored
// value. Timestamps come from one monotonic counter over a fixed epoch, so two runs of the same
// trial store byte-identical state.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- identities and clock

/** The login the trial's bearer token names (wire.ts's scenario viewer, seeded and fixed). */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's display name and e-mail, as the scenario carries them. */
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The login that owns nothing this token may read (wire.ts's scenario stranger). */
export const STRANGER_LOGIN = 'olgabauer';

/** The fixed epoch of every stored date: 2026-01-01T00:00:00Z in seconds. */
const EPOCH_SEC = 1_767_225_600;
/** Seconds between two consecutive stored events. */
const STEP_SEC = 60;

/** A deterministic clock: one counter, never the wall clock. */
export class Clock {
  #ticks = 0;

  /** The next timestamp in seconds. */
  nextSec(): number {
    const sec = EPOCH_SEC + this.#ticks * STEP_SEC;
    this.#ticks += 1;
    return sec;
  }

  /** The next timestamp as an ISO string with a trailing Z. */
  nextIso(): string {
    return isoOf(this.nextSec());
  }
}

/** Seconds since the epoch as an ISO 8601 string (UTC, second precision). */
export function isoOf(sec: number): string {
  return `${new Date(sec * 1000).toISOString().slice(0, 19)}Z`;
}

// ---------------------------------------------------------------- object database

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

/** The SHA-1 of a byte string, lowercase hex. */
export function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** A blob's object id: the classic `blob <len>\0<data>` hash. */
export function blobSha(data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`blob ${data.length}\0`, 'utf8'), data]));
}

/** One entry of a tree, as git writes it. */
export interface TreeEntry {
  readonly name: string;
  readonly mode: string;
  readonly sha: string;
}

/** A file the forge keeps in a tree: its mode and its blob id. */
export interface FileEntry {
  readonly mode: string;
  readonly sha: string;
}

/** The git object store: every object the forge serves, addressed by its SHA-1. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  /** Store one object, returning its id. Idempotent: the same bytes always give the same id. */
  put(type: ObjectType, data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    const id = sha1(Buffer.concat([header, data]));
    if (!this.objects.has(id)) this.objects.set(id, { type, data });
    return id;
  }

  /** Store a blob. */
  putBlob(data: Buffer): string {
    return this.put('blob', data);
  }

  /** One object, or undefined when the store does not hold it. */
  get(id: string): GitObject | undefined {
    return this.objects.get(id.toLowerCase());
  }

  has(id: string): boolean {
    return this.objects.has(id.toLowerCase());
  }

  /** A blob's bytes, or null when the id is not a blob the store holds. */
  blobData(id: string): Buffer | null {
    const object = this.get(id);
    return object !== undefined && object.type === 'blob' ? object.data : null;
  }

  /** Write a tree object from its entries; entries must already be sorted the way git sorts. */
  putTree(entries: readonly TreeEntry[]): string {
    const chunks: Buffer[] = [];
    for (const entry of entries) {
      chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      chunks.push(Buffer.from(entry.sha, 'hex'));
    }
    return this.put('tree', Buffer.concat(chunks));
  }

  /** Read a tree object's entries, or an empty list when it is not a tree. */
  readTree(id: string): TreeEntry[] {
    const object = this.get(id);
    if (object === undefined || object.type !== 'tree') return [];
    const entries: TreeEntry[] = [];
    const data = object.data;
    let offset = 0;
    while (offset < data.length) {
      const space = data.indexOf(0x20, offset);
      if (space === -1) break;
      const nul = data.indexOf(0x00, space);
      if (nul === -1) break;
      if (nul + 21 > data.length) break;
      const mode = data.subarray(offset, space).toString('utf8');
      const name = data.subarray(space + 1, nul).toString('utf8');
      const sha = data.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ name, mode, sha });
      offset = nul + 21;
    }
    return entries;
  }
}

/** Git's ordering inside one tree: by name bytes, a directory sorting as its name plus '/'. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const keyA = a.mode === '40000' ? `${a.name}/` : a.name;
  const keyB = b.mode === '40000' ? `${b.name}/` : b.name;
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

/**
 * Build every tree object for a flat path -> file map, returning the root tree id.
 * Intermediate directories get their own tree objects, as a real git repository has them.
 */
export function buildTreeFromFiles(store: ObjectStore, files: ReadonlyMap<string, FileEntry>): string {
  interface Dir {
    files: Map<string, FileEntry>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/').filter((part) => part !== '');
    if (parts.length === 0) continue;
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i] as string;
      let next = dir.dirs.get(name);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1] as string, entry);
  }
  const write = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of dir.files) entries.push({ name, mode: entry.mode, sha: entry.sha });
    for (const [name, child] of dir.dirs) entries.push({ name, mode: '40000', sha: write(child) });
    entries.sort(compareTreeNames);
    return store.putTree(entries);
  };
  return write(root);
}

/** Every file under a tree, as path -> FileEntry (directories are walked, never listed). */
export function readTreeFiles(store: ObjectStore, treeId: string, prefix = ''): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  for (const entry of store.readTree(treeId)) {
    if (entry.mode === '40000') {
      for (const [path, file] of readTreeFiles(store, entry.sha, `${prefix}${entry.name}/`)) out.set(path, file);
    } else {
      out.set(`${prefix}${entry.name}`, { mode: entry.mode, sha: entry.sha });
    }
  }
  return out;
}

// ---------------------------------------------------------------- commits

/** One commit's parsed fields. */
export interface CommitInfo {
  readonly sha: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly authorSec: number;
  readonly committerSec: number;
  readonly message: string;
}

/** A commit as this file writes it: a tree, parents, one author line, one message. */
export interface CommitInput {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorSec: number;
  readonly message: string;
}

/** Write a commit object and return its id, in git's own on-disk format. */
export function writeCommit(store: ObjectStore, input: CommitInput): string {
  const ident = `${input.authorName} <${input.authorEmail}> ${input.authorSec} +0000`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '');
  const body = `${lines.join('\n')}\n${input.message}`;
  return store.put('commit', Buffer.from(body, 'utf8'));
}

/** Parse a commit object's bytes, or null when they are not a commit. */
export function parseCommit(sha: string, data: Buffer): CommitInfo | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let authorSec = 0;
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const match = / (\d+) [+-]\d{4}$/.exec(author);
      authorSec = match === null ? 0 : Number(match[1]);
    }
  }
  if (tree === '') return null;
  return { sha, tree, parents, author, committer: author, authorSec, committerSec: authorSec, message };
}

/** The commit id a ref points at, following an annotated tag one level. */
export function peelToCommit(store: ObjectStore, id: string): string {
  const object = store.get(id);
  if (object === undefined) return id;
  if (object.type === 'commit') return id;
  if (object.type === 'tag') {
    const text = object.data.toString('utf8');
    const match = /^object ([0-9a-f]{40})/m.exec(text);
    if (match !== null) return peelToCommit(store, match[1] as string);
  }
  return id;
}

// ---------------------------------------------------------------- the GitHub-shaped store

/** One comment on an issue or pull request. */
export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

/** One label a repository defines. */
export interface Label {
  name: string;
  color: string;
  description: string;
  default: boolean;
}

/** One issue. */
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  pullRequest?: boolean;
}

/** One pull request. */
export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergedBy: string | null;
}

/** One repository: its REST fields, its refs and its sub-resources. */
export interface Repository {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  fork: boolean;
  createdAt: string;
  updatedAt: string;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

/** The whole forge state. */
export class Forge {
  readonly objects = new ObjectStore();
  readonly clock = new Clock();
  readonly repos = new Map<string, Repository>();
  #nextRepoId = 1;
  #nextIssueId = 1;
  #nextPullId = 1;
  #nextCommentId = 1;
  /** The last commit per branch tip, for cheap round-trips. */
  readonly commitCache = new Map<string, CommitInfo>();

  /** The repository key: owner/name, lowercased for lookups (GitHub is case-insensitive). */
  static key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  /** One repository, or undefined. */
  repo(owner: string, name: string): Repository | undefined {
    return this.repos.get(Forge.key(owner, name));
  }

  /** Create a repository record; the caller has already checked the name is free. */
  createRepo(owner: string, name: string, options: { description?: string; private?: boolean; defaultBranch?: string } = {}): Repository {
    const now = this.clock.nextIso();
    const repo: Repository = {
      id: this.#nextRepoId,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      fork: false,
      createdAt: now,
      updatedAt: now,
      defaultBranch: options.defaultBranch ?? 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.#nextRepoId += 1;
    this.repos.set(Forge.key(owner, name), repo);
    return repo;
  }

  /** Remove a repository and everything under it. */
  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Forge.key(owner, name));
  }

  /** A new global issue id. */
  issueId(): number {
    const id = this.#nextIssueId;
    this.#nextIssueId += 1;
    return id;
  }

  /** A new global pull request id. */
  pullId(): number {
    const id = this.#nextPullId;
    this.#nextPullId += 1;
    return id;
  }

  /** A new global comment id. */
  commentId(): number {
    const id = this.#nextCommentId;
    this.#nextCommentId += 1;
    return id;
  }

  /** The commit a ref points at, or undefined. */
  refSha(repo: Repository, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** The commit at the tip of a branch (a bare name or a full ref). */
  branchSha(repo: Repository, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(branch);
  }

  /** A commit's parsed fields, from the cache or the store. */
  commit(sha: string): CommitInfo | undefined {
    const cached = this.commitCache.get(sha);
    if (cached !== undefined) return cached;
    const object = this.objects.get(sha);
    if (object === undefined || object.type !== 'commit') return undefined;
    const parsed = parseCommit(sha, object.data);
    if (parsed !== null) this.commitCache.set(sha, parsed);
    return parsed ?? undefined;
  }

  /** Every file at a commit, as path -> FileEntry. */
  filesAt(sha: string): Map<string, FileEntry> {
    const commit = this.commit(sha);
    if (commit === undefined) return new Map();
    return readTreeFiles(this.objects, commit.tree);
  }

  /** All ancestors of a commit, nearest first, the commit itself included. */
  ancestors(sha: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [sha];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      out.push(next);
      const commit = this.commit(next);
      if (commit === undefined) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  /** The nearest common ancestor of two commits (the first shared entry of a walk from `a`). */
  mergeBase(a: string, b: string): string | undefined {
    const fromB = new Set(this.ancestors(b));
    for (const candidate of this.ancestors(a)) {
      if (fromB.has(candidate)) return candidate;
    }
    return undefined;
  }

  /** Write a commit from a file map, returning its id. */
  commitFiles(files: ReadonlyMap<string, FileEntry>, parents: readonly string[], message: string, whenSec = this.clock.nextSec()): string {
    const tree = buildTreeFromFiles(this.objects, files);
    const sha = writeCommit(this.objects, {
      tree,
      parents,
      authorName: VIEWER_NAME,
      authorEmail: VIEWER_EMAIL,
      authorSec: whenSec,
      message,
    });
    this.commit(sha);
    return sha;
  }

  /** Put a file into a file map, storing its blob. */
  setFile(files: Map<string, FileEntry>, path: string, data: Buffer, mode = '100644'): FileEntry {
    const sha = this.objects.putBlob(data);
    const entry: FileEntry = { mode, sha };
    files.set(path, entry);
    return entry;
  }
}

/** One forge for the process: the store every surface reads and writes. */
export const forge = new Forge();
