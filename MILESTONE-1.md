# Milestone 1 — REST v3 surface: done

`grade-local --driver process --worktree` on practice/trial-0:

    scores  {agent:0, feature:275, perf:93, perf_p50_us:295615, score:368, working:1}
    counts  git 0/30, repos 15/15, issues 15/15, pulls 20/20, graphql 0/20, mcp 0/15, protocol 5/5
    passed  55/120

`state.json` is byte-identical across two consecutive runs (checks, counts, perfTiers), so the
store is deterministic: one monotonic clock over a fixed epoch, no Date.now, no Math.random, no
port or host in any stored value.

## Files

| file | what it holds |
| --- | --- |
| `main.ts` | the starter's lifecycle, byte-identical, never touched |
| `app.ts` | one router: `/healthz`, `/api/graphql`, `/mcp`, `/{o}/{r}.git/...`, `/api/v3/...`, JSON 404 |
| `http.ts` | JSON replies + `X-GitHub-Request-Id`, body reader (`BodyError` → 400), auth/path helpers |
| `store.ts` | real git object DB (blob/tree/commit/tag, SHA-1, tree building, merge base) + GitHub resources |
| `rest.ts` | the whole `/api/v3` route table that `checks-rest.ts` drives |
| `graphql.ts` | stub, 404 (milestone 3) |
| `mcp.ts` | stub, 404 (milestone 4) |
| `git.ts` | stub, 404; `isGitPath()` already routes `/{o}/{r}.git/*` (milestone 2) |

## Milestone 2 (git smart HTTP) starts from here

* `git.ts` is already reached by the router for any `/{owner}/{repo}.git/...` path, and
  `isGitPath()` is the only thing the router checks. Fill `handleGit(req, res, path)`.
* Repositories come from `forge.repo(owner, name)` and their refs from `repo.refs`
  (`refs/heads/main` → commit sha). A push must write through `forge.objects` so REST sees the
  same objects in the same process.
* Needed: `GET /info/refs?service=git-upload-pack` (v2 advertisement when
  `Git-Protocol: version=2`, else v0 with side-band-64k), `POST /git-upload-pack` (v2 `ls-refs`
  + `fetch`, v0 fallback), `GET /info/refs?service=git-receive-pack` (v0, advertising
  report-status, side-band-64k, delete-refs), `POST /git-receive-pack` (pkt-line command list,
  pack unpack, fast-forward check per ref with `ng <ref> non-fast-forward`, sideband report).
* Pack work: read a received pack (zlib inflate per object, delta objects), write a pack
  (zlib deflate, optionally with deltas), `node:zlib` + `node:crypto` only.
* `git-client.ts` in the kit is the client the checks use — read it for the exact framing
  (`PKT_LINE_MAX`, `ZERO_OID`, `sideband` rules) before writing the server side.
* Missing repository: 404 on both services' `GET /info/refs`, server stays up.
