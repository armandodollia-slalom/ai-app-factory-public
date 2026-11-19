## Code intelligence (LSP)

The MCP server `lsp` exposes this repository's language servers. Use it for precise work at code you already located:

- Before changing existing code, confirm it: `lsp_goto_definition` and `lsp_hover` for the real definition and signature, `lsp_find_references` for every caller before you change a signature or behavior.
- After every edit, run `lsp_diagnostics` on the edited files.
- Rename with `lsp_rename` (`dry_run: true` first) instead of search and replace.
- Paths are absolute and inside your own checkout; line and column are 1-indexed. When a call answers "language server unavailable", do not retry in a loop: search instead.
