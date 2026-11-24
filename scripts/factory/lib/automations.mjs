import { setting } from '../../pipeline/lib/settings.mjs';
// `factory automations`: the tracker automations for a CI system that cannot start on tracker events
// (GitLab CI, Azure Pipelines, and GitHub Actions with a Jira or Azure Boards tracker). A scheduled job
// sweeps the tracker and runs, per ticket, the same board commands the GitHub issue workflows run:
//   every open epic         -> `board sync-epic <id>`   (its open stories get the epic's assignees)
//   every blocked ticket    -> `board resolve-check <id>` (answers checked once Resolved is ticked; with
//                              the resolved label added by a person, `--label`)
// The tracker comes from trackerFor(config) (ADAPTERS.md); `run` runs one board command.

export async function sweep(config, { tracker, run, log = () => {} }) {
  const blocked = setting(config, 'board.blockedLabel');
  const resolved = setting(config, 'board.resolvedLabel');
  const done = { epics: 0, escalations: 0, failed: [] };
  const step = async (args) => {
    try {
      const status = await run(args);
      if (status !== 0) done.failed.push(`${args.join(' ')} (exit ${status})`);
    } catch (error) {
      done.failed.push(`${args.join(' ')} (${error.message})`);
    }
  };
  for (const epic of await tracker.tickets.list({ type: 'epic', state: 'open' })) {
    log(`epic ${epic.key ?? epic.id}`);
    await step(['sync-epic', String(epic.id)]);
    done.epics++;
  }
  for (const ticket of await tracker.tickets.list({ state: 'open', label: blocked })) {
    log(`escalation ${ticket.key ?? ticket.id}`);
    await step(['resolve-check', String(ticket.id), ...((ticket.labels ?? []).includes(resolved) ? ['--label'] : [])]);
    done.escalations++;
  }
  return done;
}
