# GraphQL v4 (M3) — shapes required by the 20 checks

Endpoint: POST /api/graphql, body `{query, variables}` or an array of those.
No/blank/wrong bearer → **401**. Every check otherwise expects HTTP 200.

Query root
- `viewer{login}` → token login (adaiversen)
- `repository(owner: String!, name: String!)` → Repository or **null** (unknown → null, no errors)
- `node(id: ID!)` → Node, `... on Repository { id name nameWithOwner }`
- `__type(name: String!)` → `{name, fields(includeDeprecated){name}, enumValues(includeDeprecated){name}}`

Repository: id, databaseId, name, nameWithOwner, owner{login}, defaultBranchRef{name},
viewerPermission (ADMIN/…), hasIssuesEnabled=true, issue(number), issues(first, states,
orderBy{field,direction}, after), pullRequests(first), pullRequest(number)

Issue: id, number, title, state(OPEN/CLOSED), body
PullRequest: id, number, headRefName, baseRefName, mergeable(MERGEABLE/CONFLICTING/UNKNOWN),
state(OPEN/CLOSED/MERGED), merged, files(first){nodes{path}}
Connections: nodes + pageInfo{hasNextPage, endCursor}; IssueConnection also endCursor cursor paging.

Ordering: `orderBy:{field:CREATED_AT,direction:DESC}` → issue numbers descending, ties number DESC.
`states:[OPEN]` drops closed. No orderBy → default CREATED_AT DESC (GitHub default).
Pagination: `first` (page size), `after` cursor → next slice; hasNextPage truthful; endCursor opaque.

Mutations (all take `input:` object, return a payload field):
- createIssue{repositoryId,title,body} → issue{number,id}   (REST GET must see it)
- closeIssue{issueId} → issue{number,id,state:CLOSED}        (REST sees state closed)
- createPullRequest{repositoryId,baseRefName,headRefName,title} → pullRequest{number,id,state,headRefName,baseRefName}
  (branch was pushed over git; REST GET /pulls/{n} must show head.ref/base.ref)
- mergePullRequest{pullRequestId,mergeMethod:SQUASH} → pullRequest{number,merged:true,state}
  (REST: merged true, state closed)
- addComment{subjectId,body} → commentEdge{node{id,body}}     (REST comments list shows body)

Global ids: opaque & stable, e.g. `R_<n>`, `I_<n>`, `P_<n>`, `C_<n>`; must NOT equal the raw number.
Invalid field (`noSuchFieldOnViewer` on viewer) → **200** with `errors[]` message naming the field.
Two operation documents in one body → two results in order (array response).
Schema introspection must list the field names above and SearchType enumValues including ISSUE.

Implementation: hand-written lexer/parser/evaluator over store.ts (same objects as REST).
