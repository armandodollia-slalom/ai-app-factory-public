<!-- markdownlint-disable-file MD041 (a section the clean-code seat's task and pr-check-clean-code include: agents.mjs sharedSection) -->
- Every upheld breach of a rule is blocking: there is no minor clean-code finding. Raise each with `severity`
  `blocking`, its rule id in `rule`, and for a duplication (`CC-1`, `CC-2`; on a test plan, two cases that catch the
  same bug, `CC-14`) both places in `copies` (`["<file>:<line>", "<file>:<line>"]`, two different places). A finding
  without a rule id, or a duplication without both places, is a question, not a finding: it does not block.
- Clean-code evidence from the analysis tools (repeated values, duplication, complexity), when the task lists it, is a
  starting point, not a finding: uphold each item as your own finding, or list it in `dismissed`
  (`[{"evidence": "<the tool item>", "reason": "<why it is not a problem>"}]`; two copies that describe different
  knowledge are not duplication).
- Judge only what the change adds or edits, in the files it touches (the `SCOPE` rule): code already on the base
  branch is a follow-up, never a finding.
