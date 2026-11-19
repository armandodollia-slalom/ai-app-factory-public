## graphify

This project has a knowledge graph at `graphify-out/` (built locally; run `factory graphify-build` when `graphify-out/graph.json` is missing).

- Run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located.
- Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts.
- After modifying code, run `graphify update .` from the repository root to keep the graph current (no API cost). Always pass `.`: `graphify update <dir>` writes a second graph into that folder.
