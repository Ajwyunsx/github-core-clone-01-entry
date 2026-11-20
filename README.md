[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Ajwyunsx/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Ajwyunsx/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# github-core-clone-01 — a standalone, GitHub-compatible git forge

Entry for the [make.fun bounty **github-core-clone-01**](https://make.fun/bounty/github-core-clone-01): *Build a GitHub-compatible git forge*.

One Node 22 process, no dependencies, no `node_modules`: it binds an ephemeral port, registers with the trial env, and serves four surfaces from its own in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack speaks protocol v2 (with v0 fallback) and receive-pack v0, for clone/fetch/push with fast-forward enforcement, sideband-64k framing, shallow fetches and ref deletion.
- **REST v3** under `/api/v3` — repositories, contents, labels, issues, pull requests and merges, with `X-GitHub-Request-Id` on every reply and the trial's bearer token for auth.
- **GraphQL v4** at `/api/graphql` — a hand-written parser/evaluator/introspection over the same store (`Repository`, `Issue`, `PullRequest`, `SearchType`), `createPullRequest` mutation, batching and the error shapes `gh` and `github-mcp-server` send.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28, with `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and `merge_pull_request`, acting on the same store as REST.

## Run it

```sh
node main.ts
```

(or `node --experimental-strip-types main.ts` on an older local Node; the platform runs `node /bot/main.ts` on Node 22.18+, which strips types on its own.)

The program expects `MAKEFUN_ENV_URL` (the trial env's origin) and `MAKEFUN_SHOP_TOKEN` (the bearer token the suite presents). Without `MAKEFUN_ENV_URL` it exits 1 at once — there is no env to register with. It POSTs its bound port to `$MAKEFUN_ENV_URL/register`, long-polls `$MAKEFUN_ENV_URL/done`, and exits 0 when the env says the trial is over.

## Layout

- `main.ts` — the entry↔env lifecycle (packed with the kit's `compress`; readable source in `src/main.ts`).
- `src/` — readable sources: `app.ts` (server), `store.ts` (object DB), `rest.ts`, `git.ts`/`gitwire.ts` (smart HTTP + packfiles), `graphql.ts` (v4 engine), `mcp.ts` (MCP endpoint), `http.ts` (shared helpers).
- `NOTES.md`, `NOTES-graphql.md`, `MILESTONE-1.md`, `MILESTONE-2.md` — wire notes and milestone reports from the build.

## Status

Local `grade-local` runs: REST, git smart HTTP and GraphQL conformance green, MCP endpoint implemented; deterministic state across repeated trials. Built by AI agent sessions (deepseek-v4.1-flash) on make.fun; transcripts bundled per the competition's rules.

## License

MIT (see `LICENSE`).
