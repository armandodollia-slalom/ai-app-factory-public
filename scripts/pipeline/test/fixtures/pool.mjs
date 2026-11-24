// Test councils (GEN-9): members are pool entries and a council's size is a count, so a test that needs particular
// members with particular lenses (or a non-blocking one) seats them itself, the way a stage's orchestrator will pick
// them (GEN-11). Members are written as before: { name, cli, model (an alias or the CLI's id), lens, blocking, effort,
// env, cmd, timeoutSec }.
import { COUNCIL_STAGES, councilFor } from '../../lib/council.mjs';
import { resolveIntercom } from '../../lib/council-config.mjs';
import { familyOf } from '../../lib/pool.mjs';
import { defaultSettings, setting } from '../../lib/settings.mjs';

const IDS = {
  claude: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' },
  copilot: { opus: 'claude-opus-5.5', sonnet: 'claude-sonnet-5.5', sol: 'gpt-6.1-sol' },
  codex: { sol: 'gpt-6.1-sol' },
};

// A member as a pool entry.
export function entryOf(m) {
  return {
    name: m.name,
    cli: m.cli,
    ...(m.cli === 'custom' ? { cmd: m.cmd ?? 'true' } : { model: IDS[m.cli]?.[m.model] ?? m.model ?? IDS[m.cli]?.opus ?? 'claude-opus-5-5' }),
    effort: m.effort ?? 'high',
    ...(m.env ? { env: m.env } : {}),
    ...(m.timeoutSec ? { timeoutSec: m.timeoutSec } : {}),
  };
}

// Settings whose pool is these members; every agent, and every stage's orchestrator, runs on the first. `seats` is { <section>: councilMembers }.
export function poolSettings(members, seats = {}) {
  const pool = members.map(entryOf);
  const agents = Object.fromEntries(Object.keys(defaultSettings().models.agents).map((a) => [a, pool[0].name]));
  return { models: { pool, agents }, orchestrator: { model: pool[0].name }, ...Object.fromEntries(Object.entries(seats).map(([section, n]) => [section, { councilMembers: n }])) };
}

// The council a stage seats with exactly these members, their lenses and blocking flags. The config's pool must hold
// them (poolSettings), since each member runs on its entry.
export function seatedCouncil(config, stage, members) {
  const base = councilFor(config, stage);
  const seats = members.map((m) => {
    const e = entryOf(m);
    return { ...e, entry: m.name, family: familyOf(e), cmd: e.cmd ?? null, env: e.env ?? null, timeoutSec: e.timeoutSec ?? null, lens: m.lens, blocking: m.blocking !== false };
  });
  const sole = seats.length < 2;
  return {
    ...base,
    sole,
    members: seats,
    onUnavailable: sole ? 'fail' : setting(config, 'council.onUnavailable'),
    intercom: sole ? { ...base.intercom, enabled: false } : resolveIntercom(config?.council ?? {}, setting(config, `${base.section}.councilIntercom`)),
  };
}

// Settings for a council written the old way ({ members, stages, ...council settings }): the members become the pool
// and each listed stage's section seats as many as the stage named (all of them for `{}`). Who sits and with which
// lens is the harness's fill (one entry per family first, the stage's lens order), not the old list's.
export function councilSettings({ members = [], stages = {}, ...council }) {
  const seats = {};
  for (const [stage, s] of Object.entries(stages)) {
    const section = COUNCIL_STAGES[stage]?.section;
    if (section) seats[section] = Math.max(seats[section] ?? 0, Array.isArray(s?.members) ? s.members.length : members.length);
  }
  return { ...poolSettings(members, seats), council };
}
