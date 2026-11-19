// Scope module for lspd tests: narrows to the owned globs unless one of them is "nothing/**".
export function scope({ worktree, owns, stateDir, options }) {
  if (!worktree || !stateDir) return { ok: false, error: 'missing worktree or stateDir' };
  if (owns.includes('nothing/**')) return { ok: false, error: 'nothing matches' };
  return { ok: true, env: { FAKE_SCOPE: owns.length ? owns.join('+') : `whole:${options.root ?? ''}` }, description: owns.length ? `${owns.length} glob(s)` : 'the whole checkout' };
}
