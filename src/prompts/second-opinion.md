# Your job: conclusion

The review of this branch is finished. Afterwards an independent code review
tool reviewed the same diff without seeing that review. Its comments are listed
below. You decide, comment by comment, what each one is worth, and write the
conclusion of this second opinion.

# The finished review

These findings and observations are final. You must never drop, move, or
re-rate one of them, and never repeat one as a new finding.

{{PRIMARY_FINDINGS}}

# The second opinion

{{SECOND_OPINION}}

# How to work

Every comment is a candidate, not a fact. The tool often guesses, repeats
itself, and rates its own comments badly. Open the file and the line each
comment names, read the code at HEAD and `git diff {{BASE_SHA}}..HEAD`, and
only then decide. Give every listed comment exactly one verdict:

- `confirmed`: a real defect in the changed code, or in untouched code the diff
  breaks (then use the non-diff kinds and a cause, as in "Locations" above),
  that the finished review does not already report. Return it as a full
  `finding`. Set the severity yourself with the scale below; never copy the
  tool's own label (`high`, `medium`, `low`).
- `duplicate`: the same defect as one of the review's findings. Set
  `duplicate_of` to that finding's number. The finding stays as it is.
- `observation`: real, but not a defect under the scale below (a simpler
  alternative, a small clarity point). Return it as an `observation`.
- `rejected`: not reproducible in the code, wrong, contradicted by the ticket
  scope, an approved decision or a repository rule, pure preference, the same
  remark as one of the review's observations, or outside the diff with no
  changed line that causes it.

Every assessment has a `reason`: one plain sentence, always, also for
`confirmed` and `duplicate`.

Severity scale:

- `blocker`: breaks correctness, security, tenant isolation, or data integrity.
- `major`: works in the common case but is wrong in a real case.
- `minor`: small correctness or clarity problem with limited impact.
- `nit`: cosmetic. Prefer `observation` or `rejected` for these.

Documentation that the repository's rules require to be updated together with a
behaviour change is `major` when it is left stale; other internal docs are
`minor`.

Then write `conclusion`: two to five sentences in plain English. Say what the
second opinion added beyond the review, whether the merge decision changes and
why, and how reliable its comments were, with the counts (for example "3 of 7
comments held up").

# Output

End your answer with exactly ONE fenced ```json block and nothing after it:

```json
{
  "assessments": [
    {
      "comment": 1,
      "verdict": "confirmed|duplicate|observation|rejected",
      "reason": "one sentence",
      "duplicate_of": null,
      "finding": {
        "severity": "blocker|major|minor|nit",
        "category": "correctness|security|tenancy|tests|performance|style|docs",
        "kind": "diff|regression|stale_doc|consumer",
        "file": "src/file.ts",
        "line": 120,
        "end_line": 126,
        "cause_file": "the changed file that causes a non-diff finding, else null",
        "cause_line": 88,
        "hunk": "@@ -110,8 +110,12 @@ or null",
        "title": "short title",
        "problem": "what is wrong, in simple words",
        "why": "why it matters, what breaks",
        "suggestion": "what to do instead",
        "snippet": "a few relevant lines, or null"
      },
      "observation": null
    }
  ],
  "conclusion": "two to five sentences"
}
```

Rules for the JSON block:
- One entry per listed comment, each `comment` number once.
- `finding` only for `confirmed`, `observation` (with `file`, `line`, `note`,
  `rationale`) only for `observation`, `duplicate_of` only for `duplicate`;
  `null` otherwise.
- Use plain strings. No markdown tables inside the JSON values.
- Output valid JSON. No comments, no trailing commas, no text after the block.
