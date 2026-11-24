// Severity, computed by the harness (never by the triage agent) so it can be recomputed and explained.
//
// Ticket severity:
//   base  = max(Impact, Fix risk); Complexity is shown but feeds into Fix risk, it does not count directly
//   floor = High (implement.reviewGate.floor.minLevel) when the ticket's files hit an override path or the
//           agent put it in a floor category (auth, payments, migration, security)
//   bump  = +1 level per human reopen, capped at Severe (stored apart, so the base stays visible)
//
// PR severity = max ticket severity, +1 level when the PR touches `manySystems` (3) or more systems,
// at least High (`floor.sharedMinLevel`) when it changes shared infrastructure or an integration-event contract.
import { atLeast, bumpLevel, levelIndex, maxLevel, normalizeLevel } from './levels.mjs';
import { defaultSettings } from '../../pipeline/lib/settings.mjs';

const GATE = defaultSettings().implement.reviewGate;

export function ticketSeverity({ impact, complexity = null, fixRisk, floorReasons = [], reopens = 0 }, settings = {}) {
  const base = maxLevel(impact, fixRisk);
  if (!base) return { level: null, base: null, floor: null, bump: 0, explanation: 'not assessed' };
  const floor = floorReasons.length ? normalizeLevel(settings.floor?.minLevel ?? GATE.floor.minLevel) : null;
  const floored = floor ? atLeast(base, floor) : base;
  const bump = Math.max(0, Number(reopens) || 0);
  const level = bumpLevel(floored, bump);
  const parts = [`Impact ${normalizeLevel(impact) ?? '?'}, Fix risk ${normalizeLevel(fixRisk) ?? '?'} → ${base}`];
  if (floor && levelIndex(floored) > levelIndex(base)) parts.push(`floor ${floor} (${floorReasons.join(', ')}) → ${floored}`);
  else if (floor) parts.push(`floor ${floor} (${floorReasons.join(', ')})`);
  if (bump) parts.push(`+${bump} reopen${bump > 1 ? 's' : ''} → ${level}`);
  return { level, base, floor, bump, complexity: normalizeLevel(complexity), explanation: parts.join(', ') };
}

// Why a ticket gets the floor: override paths among its files, floor categories the agent named.
// Project manifests: a pull request that adds one adds a project whose class the architecture policy derives;
// a person sees it at High (floor.newProjects overrides the globs).
export const NEW_PROJECT_GLOBS = ['**/*.csproj', '**/*.fsproj', '**/*.vbproj', '**/package.json', '**/Cargo.toml', '**/pom.xml', '**/build.gradle', '**/build.gradle.kts', '**/go.mod', '**/pyproject.toml'];
const globRx = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '(?:.*/)?')}$`, 'i'); // manifests match without case: Up.API.CSPROJ builds like a .csproj

export function floorReasons({ files = [], added = [], categories = [] }, settings, { overridePathsHit }) {
  const reasons = overridePathsHit(files, settings).map((h) => h.path);
  const projectGlobs = (settings.floor?.newProjects ?? NEW_PROJECT_GLOBS).map(globRx);
  for (const f of added) if (projectGlobs.some((g) => g.test(f))) reasons.push(`new project ${f}`);
  const wanted = new Set((settings.floor?.categories ?? []).map((c) => c.toLowerCase()));
  for (const c of categories ?? []) if (wanted.has(String(c).toLowerCase())) reasons.push(`category ${String(c).toLowerCase()}`);
  return [...new Set(reasons)];
}

export function prSeverity({ tickets, systems }, settings = {}) {
  const levels = tickets.map((t) => t.severity?.level ?? null);
  // A ticket that was not assessed makes the PR's severity unknown (it can never auto-merge).
  if (!levels.length || levels.some((l) => !l)) return { level: null, explanation: 'not every ticket was assessed', bumped: false, floor: null };
  const top = maxLevel(levels);
  const many = settings.manySystems ?? GATE.manySystems;
  const bumped = systems.names.length >= many;
  let level = bumped ? bumpLevel(top, 1) : top;
  const parts = [`max ticket severity ${top}`];
  if (bumped) parts.push(`+1 for ${systems.names.length} systems → ${level}`);
  const floor = systems.shared || systems.contract ? normalizeLevel(settings.floor?.sharedMinLevel ?? GATE.floor.sharedMinLevel) : null;
  if (floor) {
    const before = level;
    level = atLeast(level, floor);
    const why = [systems.shared && 'shared infrastructure', systems.contract && 'an integration-event contract'].filter(Boolean).join(' and ');
    parts.push(`floor ${floor} (${why})${levelIndex(level) > levelIndex(before) ? ` → ${level}` : ''}`);
  }
  return { level, explanation: parts.join(', '), bumped, floor };
}

// The PR class the retro groups review data by, and the approvals policy table is keyed by:
// the PR severity, plus "+shared" when it changes shared infrastructure or a contract.
export const prClass = ({ severity, shared }) => `${severity ?? 'Unassessed'}${shared ? '+shared' : ''}`;
