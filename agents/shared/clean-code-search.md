<!-- markdownlint-disable-file MD041 (a section the clean-code seat's task and pr-check-clean-code include: agents.mjs sharedSection) -->
- Search the codebase yourself; never trust the change's author. For every value, constant, message and helper the
  change adds, find every existing definition and every caller: graphify first (`graphify query`, `graphify explain`,
  `graphify path`), then the language-server tools (`lsp_workspace_symbols`, `lsp_goto_definition`,
  `lsp_find_references`). The harness records these searches.
- When the task carries the orchestrator's guidance ("Where to change and what to reuse"), check it was followed: a
  change that redefines what the guidance said to reuse is a blocking finding citing the guidance, rule `CC-1` and both
  places.
