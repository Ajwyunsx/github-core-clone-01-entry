# M2 git smart-HTTP — wire notes from the kit spec (do not re-read checks-git.ts)

Repo path: `/{owner}/{repo}.git/*`; repo must already exist (created via REST) else 404 on info/refs.

## info/refs
- `GET /{o}/{r}.git/info/refs?service=git-upload-pack`
  - Header `Git-Protocol: version=2` → body starts `version 2` (pkt-line, no `# service=` preamble) with capability lines: `agent=`, `object-format=sha1`, `ls-refs=unborn`, `fetch=shallow`, maybe `server-option`. Flush at end.
  - No header → v0: `# service=git-upload-pack` pkt-line, flush, then first ref line `<oid> HEAD\0<caps>` … flush. Caps must include `side-band-64k`, `symref=HEAD:refs/heads/<default>`, `object-format` optional. Empty repo: `0000000000000000000000000000000000000000 capabilities^{}\0<caps>`.
  - Content-Type for both: `application/x-git-upload-pack-advertisement`.
- `GET ...?service=git-receive-pack` → v0 only, `# service=git-receive-pack` + flush + refs w/ caps `report-status side-band-64k delete-refs ofs-delta agent=...`; CT `application/x-git-receive-pack-advertisement`.
- Missing repo → HTTP 404 both services; server keeps serving.

## POST git-upload-pack
v2 (when Git-Protocol: version=2 was sent): pkt-line body `command=ls-refs\n` or `command=fetch\n`, `agent=`, `object-format=` lines, `delim` (0001), then args, then `flush`.
- ls-refs args: `peel`, `symrefs`, `unborn`, `ref-prefix <p>`. Response: per ref `<oid> <name>` + ` symref-target:<t>` + ` peeled:<oid>`, flush. Unborn: `unborn HEAD symref-target:refs/heads/main`.
- fetch args: `thin-pack`, `no-progress`, `ofs-delta`, `want <oid>`, `have <oid>`, `shallow <oid>`, `deepen <n>`, `done`.
  Response sections separated by delimiter: `acknowledgments\n` (ACK/NAK/ready) delim, `shallow-info\n` (`shallow <oid>`/`unshallow <oid>`) delim, `packfile\n`, then sideband pkt-lines (band byte 1=data,2=progress,3=error), flush.
  If nothing to send: acknowledgments section only (ACK <oid> / ready, no packfile).
- v0 POST: two pkt-line sections (wants+shallow/deepen, flush, haves+done, flush). Response: `NAK\n` or `ACK <oid>`, then sideband packets carrying the pack; flush.
- Content-Type: `application/x-git-upload-pack-result`.

## POST git-receive-pack (v0)
Request: pkt-line `old new ref\0caps` (first only), flush, then raw packfile.
Caps to honour: `report-status`, `side-band-64k`, `delete-refs`, `ofs-delta`.
Response: if sideband-64k: pkt-lines of band1 wrapping an inner pkt-line stream, i.e.
  outer: pktLine(chr(1) + pktLine("unpack ok\n") + pktLine("ok <ref>\n") + pktLine("ng <ref> <reason>\n") + flush("0000"))
  else the bare pkt-line stream. Final outer flush.
- Per-ref fast-forward check vs current ref: refuse with `ng <ref> non-fast-forward`. Mixed ok/ng in same report.
- Delete (new = zeros) requires `delete-refs`.

## Content types
advertisement: `application/x-git-{svc}-advertisement`; result: `application/x-git-{svc}-result`.

## Checks (30)
advertise-v2, advertise-receive-pack, advertise-headers, unknown-repo-404, ls-refs, ls-refs-prefix,
clone-empty, push-first-commit, clone-object-hashes, clone-blob-bytes, clone-tree-entries,
clone-commit-bytes, clone-annotated-tag, fetch-incremental, fetch-nothing-new, fetch-shallow-depth1,
fetch-shallow-deepen, fetch-shallow-new-tip, push-update-ref, push-create-branch, push-delete-branch,
push-non-fast-forward, push-mixed-report, push-delete-tag, push-100-files, pack-integrity,
pack-deltas, sideband-framing, push-sideband-report, repo-survives-errors

Notes: shallow clone must send `shallow-info` naming tip and omit parents. deepen 2 → give parent, not grandparent, and move boundary. Client always sends `thin-pack ofs-delta`; safest = full (non-delta) pack, which passes pack-deltas trivially. Object hashes must be exact; packs must be v2 with correct SHA-1 trailer.
