// Git smart HTTP: protocol v2 for reads (upload-pack), v0 for writes (receive-pack), over the same
// object database the REST surface writes into. Every byte here is a pkt-line or a packfile; the
// encodings live in gitwire.ts, this file is the protocol state machine.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   -> v2 capabilities (Git-Protocol: version=2)
//                                                                or the v0 ref advertisement
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  -> the v0 ref advertisement with push caps
//   POST /{owner}/{repo}.git/git-upload-pack                     -> ls-refs / fetch (v2), or a v0 want list
//   POST /{owner}/{repo}.git/git-receive-pack                    -> command list + pack, report-status back

import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorBody, readRawBody, sendJson } from './http.ts';
import { forge, type GitObject, type ObjectType, type Repository } from './store.ts';
import {
  FLUSH,
  decodePackets,
  oidOf,
  pkt,
  pktLines,
  readPack,
  sidebandChunks,
  tagTarget,
  writePack,
  type Packet,
} from './gitwire.ts';

const ZERO_OID = '0'.repeat(40);

/** Capabilities the receive-pack advertisement offers: exactly what this server honours. */
const RECEIVE_CAPS = ['report-status', 'sideband-64k', 'delete-refs', 'ofs-delta', 'agent=forge/1.0'];
const UPLOAD_V0_CAPS = ['side-band-64k', 'ofs-delta', 'no-progress', 'agent=forge/1.0'];
const UPLOAD_V2_CAPS = ['agent=forge/1.0', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];

/** Whether a path names a smart-HTTP endpoint: /{owner}/{repo}.git/... */
export function isGitPath(path: string): boolean {
  return /^\/[^/]+\/[^/]+\.git(\/|$)/.test(path);
}

interface GitTarget {
  readonly owner: string;
  readonly repo: string;
  readonly rest: string;
}

function splitPath(path: string): GitTarget | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (match === null) return null;
  const owner = decodeURIComponent(match[1] as string);
  const repo = decodeURIComponent(match[2] as string);
  const rest = (match[3] ?? '/').replace(/\/+$/, '') || '/';
  return { owner, repo, rest };
}

function findRepo(target: GitTarget): Repository | undefined {
  return forge.repo(target.owner, target.repo);
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': 'no-cache, max-age=0, must-revalidate',
  });
  res.end(body);
}

function fail(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, errorBody(message));
}

// ---------------------------------------------------------------- refs

function refNames(repo: Repository): string[] {
  return [...repo.refs.keys()].sort();
}

/** The ref HEAD points at: refs/heads/<defaultBranch>, whether or not it exists yet. */
function headTarget(repo: Repository): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Peel an annotated tag chain to the first non-tag object; a commit id passes through. */
function peel(oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const object = forge.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    const next = tagTarget(object.data);
    if (next === null) return current;
    current = next;
  }
  return current;
}

/** The commit an id names, or undefined when it is not a commit or a tag of one. */
function commitOf(oid: string): string | undefined {
  const peeled = peel(oid);
  const object = forge.objects.get(peeled);
  return object !== undefined && object.type === 'commit' ? peeled : undefined;
}

// ---------------------------------------------------------------- advertisements

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repository): Buffer {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : [...UPLOAD_V0_CAPS, `symref=HEAD:${headTarget(repo)}`];
  const items: Array<Buffer | 'flush'> = [`# service=${service}\n`, 'flush'];
  const names = refNames(repo);
  if (names.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\u0000${caps.join(' ')}\n`);
  } else {
    if (service === 'git-upload-pack') {
      const head = repo.refs.get(headTarget(repo));
      if (head !== undefined) items.push(`${head} HEAD\u0000${caps.join(' ')}\n`);
    }
    names.forEach((name, index) => {
      const oid = repo.refs.get(name) as string;
      const first = index === 0 && service === 'git-receive-pack';
      items.push(first ? `${oid} ${name}\u0000${caps.join(' ')}\n` : `${oid} ${name}\n`);
      if (service === 'git-upload-pack' && name.startsWith('refs/tags/')) {
        const object = forge.objects.get(oid);
        if (object !== undefined && object.type === 'tag') {
          const target = peel(oid);
          if (target !== oid) items.push(`${target} ${name}^{}\n`);
        }
      }
    });
  }
  items.push('flush');
  return pktLines(items);
}

function v2Advertisement(): Buffer {
  const items: Array<Buffer | 'flush'> = ['version 2\n'];
  for (const capability of UPLOAD_V2_CAPS) items.push(`${capability}\n`);
  items.push('flush');
  return pktLines(items);
}

// ---------------------------------------------------------------- object sets

interface RepoCache {
  reach: Map<string, Set<string>>;
  packs: Map<string, Buffer>;
}

const caches = new Map<string, RepoCache>();

/**
 * Per-repository caches. Safe without invalidation: objects are immutable and keyed by their own
 * SHA-1, and every pack key names the exact want/have/depth set it was built from.
 */
function cacheFor(repo: Repository): RepoCache {
  const key = `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
  let cache = caches.get(key);
  if (cache === undefined) {
    cache = { reach: new Map(), packs: new Map() };
    caches.set(key, cache);
  }
  return cache;
}

/** Every object reachable from an id (commit -> tree -> blobs / subtrees / parents), memoised. */
function reachable(oid: string, cache?: RepoCache): Set<string> {
  const cached = cache?.reach.get(oid);
  if (cached !== undefined) return cached;
  const seen = new Set<string>();
  const queue: string[] = [oid];
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (seen.has(next)) continue;
    const object = forge.objects.get(next);
    if (object === undefined) continue;
    seen.add(next);
    if (object.type === 'commit') {
      const text = object.data.toString('utf8');
      const tree = /^tree ([0-9a-f]{40})$/m.exec(text);
      if (tree !== null) queue.push(tree[1] as string);
      for (const line of text.split('\n')) {
        if (line.startsWith('parent ')) queue.push(line.slice(7).trim());
        else if (line === '') break;
      }
    } else if (object.type === 'tree') {
      for (let offset = 0; offset < object.data.length; ) {
        const space = object.data.indexOf(0x20, offset);
        const nul = object.data.indexOf(0x00, space);
        if (space < 0 || nul < 0) break;
        queue.push(object.data.subarray(nul + 1, nul + 21).toString('hex'));
        offset = nul + 21;
      }
    } else if (object.type === 'tag') {
      const target = tagTarget(object.data);
      if (target !== null) queue.push(target);
    }
  }
  if (cache !== undefined && cache.reach.size < 5000) cache.reach.set(oid, seen);
  return seen;
}

function parentsOf(commit: string): string[] {
  const object = forge.objects.get(commit);
  if (object === undefined || object.type !== 'commit') return [];
  const out: string[] = [];
  for (const line of object.data.toString('utf8').split('\n')) {
    if (line.startsWith('parent ')) out.push(line.slice(7).trim());
    else if (line !== '' && !line.startsWith('tree ')) {
      if (!line.startsWith('author ') && !line.startsWith('committer ')) break;
    }
  }
  return out;
}

/** True when `ancestor` is `descendant` itself or reachable from it through parents. */
function isAncestor(ancestor: string, descendant: string): boolean {
  const start = commitOf(descendant);
  if (start === undefined) return false;
  const target = commitOf(ancestor) ?? ancestor;
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (next === target) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const parent of parentsOf(next)) queue.push(parent);
  }
  return false;
}

interface FetchPlan {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly cacheKey: string;
  readonly pack: Buffer | undefined;
}

/**
 * One commit's own payload: the commit, its tree and everything below that tree — never a parent.
 * A shallow client holds exactly this much for the commits it has.
 */
function commitClosure(commit: string, cache: RepoCache): string[] {
  const object = forge.objects.get(commit);
  if (object === undefined || object.type !== 'commit') return [commit];
  const tree = /^tree ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
  const out = [commit];
  if (tree !== null) for (const oid of reachable(tree[1] as string, cache)) out.push(oid);
  return out;
}

/**
 * The objects a fetch should send.
 *
 * Shallow (`depth` set): walk `depth` generations of commits from the wants, send each commit with
 * its tree closure, and subtract only what the client's haves *own* (a shallow client holds a
 * commit's tree, not its parents' history). Deep (`depth` null): send everything reachable from the
 * wants, minus everything reachable from the haves.
 */
function planFetch(repo: Repository, wants: readonly string[], haves: readonly string[], depth: number | null, boundaries: readonly string[]): FetchPlan {
  const cache = cacheFor(repo);
  const keys = [...wants].sort();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const selected = new Set<string>();

  if (depth !== null && depth > 0) {
    const levels: string[][] = [];
    const level0 = wants.map((want) => commitOf(want) ?? want).filter((oid) => oid !== '');
    levels.push(level0);
    const seenCommits = new Set<string>(level0);
    for (let level = 1; level < depth; level += 1) {
      const next: string[] = [];
      for (const commit of levels[level - 1] as string[]) {
        for (const parent of parentsOf(commit)) {
          if (seenCommits.has(parent)) continue;
          seenCommits.add(parent);
          next.push(parent);
        }
      }
      levels.push(next);
    }
    const boundaryLevel = levels[Math.min(depth, levels.length) - 1] as string[];
    for (const commit of boundaryLevel) if (parentsOf(commit).length > 0) shallow.push(commit);
    for (const level of levels) {
      for (const commit of level) for (const oid of commitClosure(commit, cache)) selected.add(oid);
    }
    const held = new Set<string>();
    for (const have of haves) {
      const start = commitOf(have) ?? have;
      for (const oid of commitClosure(start, cache)) held.add(oid);
    }
    for (const oid of held) selected.delete(oid);
    // A boundary the client already held but that is no longer a boundary has been deepened past.
    for (const old of boundaries) {
      const stillBoundary = shallow.includes(old);
      if (!stillBoundary && !held.has(old)) unshallow.push(old);
      else if (!stillBoundary && held.has(old)) unshallow.push(old);
    }
  } else {
    for (const want of wants) for (const oid of reachable(want, cache)) selected.add(oid);
    if (haves.length > 0) {
      const held = new Set<string>();
      for (const have of haves) {
        if (forge.objects.get(have) === undefined) continue;
        for (const oid of reachable(have, cache)) held.add(oid);
      }
      for (const oid of held) selected.delete(oid);
    }
    for (const old of boundaries) if (!selected.has(old)) unshallow.push(old);
  }

  const ids = [...selected].sort();
  const cacheKey = `${keys.join(',')}|${[...haves].sort().join(',')}|${depth ?? '-'}|${[...boundaries].sort().join(',')}|${[...shallow].sort().join(',')}`;
  const cachedPack = cache.packs.get(cacheKey);
  const objects: GitObject[] = [];
  for (const oid of ids) {
    const object = forge.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow, unshallow, cacheKey, pack: cachedPack };
}

// ---------------------------------------------------------------- request parsing

interface RequestLines {
  readonly command: string;
  readonly args: string[];
}

/** A v2 request: `command=...` before the delimiter, its arguments after it. */
function parseV2Request(body: Buffer): RequestLines {
  const packets = decodePackets(body);
  let command = '';
  let seenDelim = false;
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\r?\n$/, '');
    if (line === '') continue;
    if (!seenDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).trim();
      continue;
    }
    args.push(line);
  }
  return { command, args };
}

/** A v0 want list: two pkt-line sections, wants first and the negotiation second. */
function parseV0Wants(body: Buffer): { wants: string[]; haves: string[]; depth: number | null; shallow: string[] } {
  const packets = decodePackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\r?\n$/, '');
    if (line.startsWith('want ')) wants.push(line.split(' ')[1] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim()) || null;
    else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) depth = depth ?? 1;
  }
  return { wants, haves, depth, shallow };
}

// ---------------------------------------------------------------- ls-refs

/** v2 ls-refs: HEAD (symref/unborn on request), every ref, and peeled tags. */
function handleLsRefs(repo: Repository, args: readonly string[]): Buffer {
  let peelWanted = false;
  let symrefsWanted = false;
  let unbornWanted = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peelWanted = true;
    else if (arg === 'symrefs') symrefsWanted = true;
    else if (arg === 'unborn') unbornWanted = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const items: Array<Buffer | 'flush'> = [];
  const head = repo.refs.get(headTarget(repo));
  const headSuffix = symrefsWanted ? ` symref-target:${headTarget(repo)}` : '';
  if (keep('HEAD')) {
    if (head !== undefined) items.push(`${head} HEAD${headSuffix}\n`);
    else if (unbornWanted) items.push(`unborn HEAD${headSuffix}\n`);
  }
  for (const name of refNames(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peelWanted && name.startsWith('refs/tags/')) {
      const peeled = peel(oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    items.push(`${line}\n`);
  }
  items.push('flush');
  return pktLines(items);
}

// ---------------------------------------------------------------- fetch

/** v2 fetch: acknowledgments, an optional shallow-info section, then the packfile section. */
function handleFetchV2(repo: Repository, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const boundaries: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) boundaries.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim()) || null;
    else if (arg.startsWith('deepen-since ') || arg.startsWith('deepen-not ')) depth = depth ?? 1;
  }
  const valid = wants.filter((oid) => /^[0-9a-f]{40}$/.test(oid) && forge.objects.has(oid));
  if (valid.length === 0) return pktLines(['acknowledgments\n', 'NAK\n', 'flush']);

  const goodHaves = haves.filter((oid) => /^[0-9a-f]{40}$/.test(oid));
  const plan = planFetch(repo, valid, goodHaves, depth, boundaries);

  const items: Array<Buffer | 'flush' | 'delim'> = ['acknowledgments\n'];
  if (goodHaves.length > 0) {
    for (const have of goodHaves) items.push(`ACK ${have}\n`);
    items.push('ready\n');
  } else {
    items.push('NAK\n');
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    items.push('delim', 'shallow-info\n');
    for (const oid of plan.shallow) items.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) items.push(`unshallow ${oid}\n`);
  }
  if (plan.objects.length > 0) {
    items.push('delim', 'packfile\n');
    for (const chunk of sidebandChunks(cachedPack(repo, plan))) items.push(chunk);
  }
  items.push('flush');
  return pktLines(items);
}

/** Build (or reuse) the pack for a plan; packs are content-addressed by the request shape. */
function cachedPack(repo: Repository, plan: FetchPlan): Buffer {
  if (plan.pack !== undefined) return plan.pack;
  const cache = cacheFor(repo);
  const pack = writePack(plan.objects);
  if (cache.packs.size < 64) cache.packs.set(plan.cacheKey, pack);
  return pack;
}

function handleFetchV0(repo: Repository, body: Buffer): Buffer {
  const request = parseV0Wants(body);
  const wants = request.wants.filter((oid) => /^[0-9a-f]{40}$/.test(oid) && forge.objects.has(oid));
  const plan = planFetch(repo, wants, request.haves, request.depth, request.shallow);
  const items: Array<Buffer | 'flush'> = [];
  for (const oid of plan.shallow) items.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) items.push(`unshallow ${oid}\n`);
  items.push('NAK\n');
  if (plan.objects.length > 0) {
    for (const chunk of sidebandChunks(cachedPack(repo, plan))) items.push(chunk);
  }
  items.push('flush');
  return pktLines(items);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function parseCommands(body: Buffer): { commands: PushCommand[]; capabilities: Set<string>; pack: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  let sawFlush = false;
  while (offset + 4 <= body.length) {
    const header = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      sawFlush = true;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (!sawFlush) throw new Error('push body has no flush before the pack');
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  packets.forEach((packet, index) => {
    let text = packet.payload.toString('utf8');
    text = text.replace(/\n$/, '');
    if (index === 0) {
      const nul = text.indexOf('\u0000');
      if (nul >= 0) {
        for (const cap of text.slice(nul + 1).split(' ')) if (cap !== '') capabilities.add(cap);
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length < 3) return;
    const [oldOid, newOid, ...rest] = parts;
    if (!/^[0-9a-f]{40}$/.test(oldOid ?? '') || !/^[0-9a-f]{40}$/.test(newOid ?? '')) return;
    commands.push({ oldOid: oldOid as string, newOid: newOid as string, ref: rest.join(' ') });
  });
  return { commands, capabilities, pack: body.subarray(offset) };
}

interface RefVerdict {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason: string;
}

function applyCommands(repo: Repository, commands: readonly PushCommand[]): RefVerdict[] {
  const verdicts: RefVerdict[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'not found' });
        continue;
      }
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'stale info' });
        continue;
      }
      repo.refs.delete(command.ref);
      verdicts.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!forge.objects.has(command.newOid)) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'missing necessary objects' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'stale info' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      verdicts.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!isAncestor(current, command.newOid)) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    verdicts.push({ ref: command.ref, ok: true, reason: '' });
  }
  if (verdicts.some((verdict) => verdict.ok)) repo.updatedAt = forge.clock.nextIso();
  return verdicts;
}

function handleReceive(repo: Repository, body: Buffer): Buffer {
  const parsed = parseCommands(body);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (parsed.pack.length > 0) {
    try {
      const pack = readPack(parsed.pack);
      for (const [oid, object] of pack.objects) {
        if (!forge.objects.objects.has(oid)) forge.objects.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const verdicts = unpackOk
    ? applyCommands(repo, parsed.commands)
    : parsed.commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpacker error' }));

  const status: Array<Buffer | 'flush'> = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const verdict of verdicts) {
    status.push(verdict.ok ? `ok ${verdict.ref}\n` : `ng ${verdict.ref} ${verdict.reason}\n`);
  }
  status.push('flush');
  const inner = pktLines(status);
  if (parsed.capabilities.has('side-band-64k')) {
    const outer: Array<Buffer | 'flush'> = [Buffer.concat([Buffer.from([1]), inner])];
    outer.push('flush');
    return pktLines(outer);
  }
  return inner;
}

// ---------------------------------------------------------------- routing

export async function handleGit(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const target = splitPath(path);
  if (target === null) {
    fail(res, 404, 'Not Found');
    return;
  }
  const repo = findRepo(target);
  const method = (req.method ?? 'GET').toUpperCase();
  const queryIndex = (req.url ?? '').indexOf('?');
  const query = new URLSearchParams(queryIndex >= 0 ? (req.url ?? '').slice(queryIndex + 1) : '');
  const service = query.get('service');

  if (target.rest === '/info/refs') {
    if (repo === undefined) {
      fail(res, 404, 'Not Found');
      return;
    }
    if (service === 'git-upload-pack') {
      const wantsV2 = /version=2/.test(String(req.headers['git-protocol'] ?? ''));
      const body = wantsV2 ? v2Advertisement() : v0Advertisement('git-upload-pack', repo);
      send(res, 200, 'application/x-git-upload-pack-advertisement', body);
      return;
    }
    if (service === 'git-receive-pack') {
      send(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement('git-receive-pack', repo));
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  if (target.rest !== '/git-upload-pack' && target.rest !== '/git-receive-pack') {
    fail(res, 404, 'Not Found');
    return;
  }
  if (repo === undefined) {
    fail(res, 404, 'Not Found');
    return;
  }
  if (method !== 'POST') {
    fail(res, 404, 'Not Found');
    return;
  }

  const body = await readRawBody(req);
  if (target.rest === '/git-receive-pack') {
    send(res, 200, 'application/x-git-receive-pack-result', handleReceive(repo, body));
    return;
  }

  const wantsV2 = /version=2/.test(String(req.headers['git-protocol'] ?? ''));
  if (!wantsV2) {
    send(res, 200, 'application/x-git-upload-pack-result', handleFetchV0(repo, body));
    return;
  }
  const request = parseV2Request(body);
  if (request.command === 'ls-refs') {
    send(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, request.args));
    return;
  }
  if (request.command === 'fetch') {
    send(res, 200, 'application/x-git-upload-pack-result', handleFetchV2(repo, request.args));
    return;
  }
  fail(res, 400, 'unknown upload-pack command');
}

/** A bare packfile writer for callers outside the HTTP surface (tests, tooling). */
export function packObjects(objects: readonly GitObject[]): Buffer {
  return writePack(objects);
}

/** The object id for a payload, exposed so callers can address what they just stored. */
export function objectId(type: ObjectType, data: Buffer): string {
  return oidOf(type, data);
}

/** The flush constant, re-exported for tests that hand-build a request. */
export const FLUSH_PACKET = FLUSH;
