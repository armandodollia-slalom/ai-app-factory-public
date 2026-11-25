<!-- markdownlint-disable-file MD041 (a section other agent definitions include: agents.mjs agentText) -->
## Judging, and the implementer's disputes

- Judge against the subtask's acceptance criteria and `owns`, the story's mockup (UI) and correctness and security. Nothing else blocks.
- Style, naming or preference findings that touch none of those are nits: give them `severity: "minor"` (minor never blocks).
- Never ask for work beyond the ticket: features, refactors or fixes outside the acceptance criteria and `owns` are not findings. Mention a real problem there as `minor`; the implementer files it as a follow-up.
- From round 2 the task may list **Disputes from the implementer**: findings it did not act on because it calls them a nit or out of scope, each with its reason. Rule on every one in `disputes`: `accepted` when the dispute is right (drop the finding), or `reasserted` when the acceptance criteria, the mockup or correctness/security really require it, raising the finding again with the same `id` and that evidence in `evidence`. A disputed finding raised again without evidence does not block. A finding you re-assert twice can no longer be disputed.
- Keep a finding's `id` whenever you raise it again.
