# Milestone 2 — git smart HTTP: done

`grade-local --driver process --worktree` on practice/trial-0:

    scores  {"agent":0,"feature":525,"perf":185,"perf_p50_us":231746,"score":710,"working":1}
    counts  git 30/30, graphql 20/20, issues 15/15, mcp 0/15, pulls 20/20, protocol 5/5, repos 15/15
    passed  105/120

`state.json` sha256 `23a2b97b…` on two consecutive full grades, byte for byte. The same run before
`graphql.ts` landed was 85/120 (feature 425); the 20 GraphQL checks are what moved it.

## Files

| file | what it holds |
| --- | --- |
| `gitwire.ts` | pkt-line codec (`pkt`, `pktLines`, `decodePackets`), packfile reader (`readPack`: inflate-at-an-offset, ofs/ref deltas, trailer check), writer (`writePack`, non-delta), `oidOf`, `tagTarget`, `sidebandChunks` |
| `git.ts` | the protocol state machine: advertisements (v2 caps, v0 upload, v0 receive), `ls-refs`, `fetch` (v2 sections and v0 negotiation), shallow planning, receive-pack (command list, pack ingest, per-ref fast-forward, report-status), `handleGit` routing, reply memo |
| `NOTES.md` | the wire shapes, distilled once from `checks-git.ts`, so the spec is never re-read |

## How the hard parts work

* **Pack walking.** `zlib.inflateSync(slice, {finishFlush: Z_SYNC_FLUSH, info: true})` reports
  `engine.bytesWritten`, which is how many compressed bytes the object actually consumed — that,
  not the inflated length, is what advances the cursor through a pack.
* **Shallow.** `commitClosure(commit)` = the commit plus everything under its tree, never a parent.
  Depth-1 sends exactly one closure and reports `shallow <tip>`; `deepen 2` adds the parent's
  closure, moves the boundary down a generation and reports `unshallow <old tip>`.
* **Fast-forward.** `isAncestor(current, new)` walks `parent` lines; a refusal is the literal
  reason string `non-fast-forward` in `ng <ref> non-fast-forward`, and a mixed command list gets a
  mixed report in the same `report-status` stream.
* **Sideband.** `sidebandChunks` returns *raw payloads* (band byte + slice); `pktLines` frames them
  once. Framing twice was the bug that cost the most time here.
* **Pack cache and reply memo.** Objects are immutable and content-addressed, so a fetched pack is
  keyed by its exact want/have/depth/boundary set and never invalidated. Whole replies are memoised
  behind a refs fingerprint that clears the map when any ref moves.

## Measured (process driver, 1 trial)

    push   200 sequential 1 KiB pushes        235 ms   (T_ref 1641)  50 pts
    clone  50 concurrent depth-1 clones       184 ms   (T_ref  267)  32 pts
    read   2000 keep-alive GETs               739 ms   (T_ref 2760)  49 pts
    write  200 sequential issue writes        123 ms   (T_ref  349)  44 pts

Clone is the one under parity: 150 concurrent requests is close to this box's bare-HTTP floor
(measured ~60–140 ms for 150 concurrent no-op requests), so the remainder is host noise more than
protocol work. It is worth ~10–18 perf points, against 200 agent points still unclaimed by MCP.

## Next: M3 is already in, M4 is the gap

`graphql.ts` landed during this milestone (20/20) — a parallel session wrote it into this tree while
the git work was running, and my `git add -A` commits swept it in. It is not part of the git work. `mcp.ts` is still
the 336-byte stub: it is the whole `mcp` group (15 checks = 75 feature points) *and* the entire agent
column (200 points), i.e. the largest single block left on the board.
