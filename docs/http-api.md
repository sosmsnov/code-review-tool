# HTTP API

The UI is a client of this API, which listens on `127.0.0.1:PORT` without
authentication. Errors come back as `{ "error": "…" }` with a 4xx or 5xx status.

| method | path | body / query | returns |
|---|---|---|---|
| GET | `/api/health` | | `{ ok, version, dockerImage, trackers, reviewers, defaultReviewer, repos, previews }`; tracker names and the repository count only, reviewers without model lists |
| GET | `/api/reviewers` | | `{ reviewers, defaultReviewer, second_opinion }`; each reviewer with `name`, `label`, `bin`, `available`, `defaultModel`, `models`; `second_opinion` is `{ providers: [{ name, label, available, hint }], default }` |
| GET | `/api/repos` | | `{ repos }`: the allowed repository names |
| GET | `/api/repos/:repo/branches` | `?q=` | `{ repo, defaultBranch, branches, total, truncated }`: remote branches, default first, then alphabetical, at most 200; listed in the sandbox and cached for a minute |
| GET | `/api/local-repos` | | `{ repos, unavailable }`: configured local clones with their checked-out branch, default base, dirty state, and branches (unpushed, ahead, behind) |
| GET | `/api/local-repos/:repo/parent` | `?branch=` | `{ branch, base, reason, distance, defaultBase }`: the detected parent; `reason` is `ancestor`, `fork-point`, or `default` |
| GET | `/api/tickets/<input>` | | `{ ticket, targets }`: what any [input](usage.md#inputs) resolves to, without starting anything (URL-encode the input, slashes included; at most 512 characters, as for `POST /api/reviews`) |
| POST | `/api/reviews` | `{ input, targets?, reviewer?, model?, requirementsText?, includeWorkingTree?, baseBranch?, secondOpinion? }` | `201 { reviews }`: one queued run per target; `targets` narrows a ticket to some of its branches; `secondOpinion` is `none` or a provider (default `SECOND_OPINION`), `400` when the provider is not installed |
| GET | `/api/reviews` | `?q=&ticket=&repo=&branch=&group=&limit=&offset=` | `{ reviews, total }`, newest first; `limit` 1–500, default 50; each row has `links: { branch, pr }`, its GitHub URLs (`pr` null without a PR number), and `ticket_label: { text, key, from }` (null when nothing names the ticket): the ticket key (`from: ticket`), the key in the branch name (`branch`), or the title of pasted requirements (`title`, `key` null); `second_opinion` is the [summary](#second_opinion) |
| GET | `/api/review-groups` | `?q=&status=active\|failed\|done&limit=&offset=` | `{ groups, total }`, most recently active group first; `limit` 1–100, default 20; each branch has `prNumber` (the newest any of its runs knew) and `links: { branch, pr }` |
| GET | `/api/reviews/:id` | | `{ review, requirements, findings, observations, changed_files, logs, comparison, links, ticket_group }`; `ticket_group` (null without a ticket) has the group key, this branch's parent, and the latest coverage with each requirement's `where` (`here`, `elsewhere`, `nowhere`) seen from this branch; `links` holds the GitHub URLs (`repo`, `branch`, `pr`, `compare`, `head`, `base`); `changed_files` is the changed set the anchor check used (`path`, `status`, `old_path`, `additions`, `deletions`); a finding has `corroborated` 1 when the second opinion reported it too |
| GET | `/api/reviews/:id/report` | | the Markdown report (`text/markdown`) |
| GET | `/api/reviews/:id/events` | | server-sent events: `status`, `log`, and `done` messages |
| POST | `/api/reviews/:id/rerun` | `{ reviewer?, model?, secondOpinion? }` | `201 { review }`: a new run of the same branch; without `secondOpinion` it keeps the previous run's choice (`none` included); a run older than the second opinion stage gets `SECOND_OPINION` |
| POST | `/api/reviews/:id/cancel` | | `{ review }`; `409` when it is not queued or running |
| DELETE | `/api/reviews/:id` | | `{ ok: true }`; deletes the row, the report file, and its raw pass outputs; 409 while the review is queued or running (cancel it first) |
| GET | `/api/ticket-groups/:key` | `?run=` | `{ group, coverage, latest_coverage, coverage_pending, run }`: the chains per repository in stack order (each branch with `parent`, `parentReason`, `depth`, `latest` and `latestDone` run with `code_verdict`), the latest finished coverage, a newer running or failed pass, and the latest (or the given) ticket review run; `404` without a group |
| GET | `/api/ticket-groups/:key/coverage/report` | `?id=` | the coverage report (`text/markdown`) |
| GET | `/api/ticket-groups/:key/preview-plan` | `?recipe=` (optional with one recipe) | `{ ticket, recipe, roles, request, live_preview, other_live, notes }`: per role the chain tip of its repo (`branch`, `base`, `usedBase`, `source`, `chain`), the `POST /api/previews` body that runs it, a queued/starting/ready preview that runs exactly these branches, the ticket's other live previews; `404` without a group, `400` for an unknown recipe or several recipes and none named, `409` when previews are disabled |
| POST | `/api/tickets/:key/review` | `{ reviewer?, model?, requirementsText?, branches?, refresh?, secondOpinion? }` | `201 { run, reviews, notes, group, coverage, ... }`: one queued run per branch, parents first, each against its parent; `branches` (`["repo#branch"]`) narrows it; `refresh: false` skips the tracker; this can take minutes (ticket lookup, branch listing, compare) |
| POST | `/api/tickets/:key/coverage` | `{ reviewer?, model? }` | `202 { started, coverage }`: a coverage pass now; joins a running one |
| GET | `/api/ticket-groups/:key/requirements` | | `{ key, derived_at, not_verifiable_notes, items, removed, deriving, derive_error }`: the stored checklist; each item has `id`, `position`, `text`, `source` (`derived`, `user`), `state` |
| PUT | `/api/ticket-groups/:key/requirements` | one of `{ items: [{ id?, text }] }` (the whole active list in order; left out = removed), `{ user: [text] }` (replaces user items), `{ add: [text] }` | the checklist; a reworded derived item becomes a user item; `404` for an id of another ticket |
| POST | `/api/tickets/:key/requirements/derive` | `{ reviewer?, model?, wait? }` | `202` with the checklist and `deriving: true` (or, with `wait`, the new checklist): derive again; joins a running derivation; reviewer and model default to the ticket's latest review |
| PUT | `/api/tickets/:key/parent` | `{ repo, branch, parent }` | the ticket payload; `parent: null` = the default branch; `400` for a loop |
| PUT | `/api/tickets/:key/order` | `{ repo, branches, root? }` | the ticket payload: the branches become one chain in that order |
| POST | `/api/tickets/:key/detect` | `{ reset? }` | `{ detected, ...ticket payload }`: detect parents again; `reset` also replaces parents set by hand |
| GET | `/api/recipes` | | `{ enabled, dir, recipes, errors }`: loaded preview recipes, and every invalid one with the reason |
| GET | `/api/previews` | `?reviewId=&ticket=&recipe=&limit=&offset=` | `{ previews, total }`, newest first; `limit` 1–500, default 50 |
| GET | `/api/previews/:id` | | `{ preview, logs }` |
| POST | `/api/previews` | `{ reviewId?, ticket?, recipe?, roles?, dumpMode? }`; `roles: [{ role, branch?, base?, local? }]`, a local branch as `local: true` or `branch: "local:<repo>#<branch>"` | `201 { preview }`, queued; `400` when a role, branch or local branch does not exist; `409` when previews are disabled |
| POST | `/api/previews/:id/stop` | | `{ preview }` at once, `stopping` while `down` runs in the background (follow it with `GET /api/previews/:id`); a second stop joins the running one; an ended preview is returned as it is |
| DELETE | `/api/previews/:id` | | `{ ok: true }`: stops it first, then deletes the row and its scratch directory |
| GET | `/api/previews/:id/events` | | server-sent events: `status`, `log`, and `ready` messages |

`status` on `/api/review-groups` is judged per group: `active` when a run is
queued, fetching, or reviewing; `failed` when the latest run of one of its
branches failed; `done` when nothing is running or failed and at least one
branch has a verdict.

### `second_opinion`

Every route that returns a review row (`POST /api/reviews`, the re-run, the
cancel, the ticket batch, `GET /api/reviews/:id`) serves `second_opinion`
parsed: null when the run has no second opinion (none chosen, or a run older
than the stage), else `{ provider, status
(pending | running | done | failed | skipped), requested_at, started_at,
finished_at, elapsed_ms, model, tokens, files_reviewed, partial,
comments_total, counts, comments, conclusion, primary_verdict,
primary_can_merge, error }`, where each comment carries its `assessment`
(`verdict`, `reason`, `duplicate_of`, `finding_ord`). `GET /api/reviews`
serves the summary instead: `{ provider, status, comments_total, counts,
primary_verdict, elapsed_ms, tokens_total, error }`.
