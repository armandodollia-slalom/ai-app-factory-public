// A scripted demo-narrator for the suites (no live model): it reads the videos and recorded steps from the task the
// harness built and answers with a script bound to them, the way the agent is asked to. `write(video)` may replace the
// segments of a video (to test validation); every task is kept in `tasks`.
const ORDINALS = ['First', 'Next', 'Then', 'After that', 'Now', 'From there', 'Following that', 'At this point', 'With that done', 'Moving on', 'Later', 'Finally'];

export function videosOfTask(task) {
  const out = [];
  for (const part of String(task).split('\n## Video ').slice(1)) {
    const id = part.split('\n', 1)[0].trim();
    const json = /```json\n([\s\S]*?)\n```/.exec(part)?.[1];
    out.push({ id, steps: json ? JSON.parse(json) : [], before: /BEFORE THE FIX/.test(part), after: /AFTER THE FIX/.test(part) });
  }
  return out;
}

export function defaultScript(v) {
  const segments = [{ role: 'opening', text: v.before ? 'Before the fix, the user tries the flow the ticket describes.' : 'The user wants to get to what the ticket promises.' }];
  let n = 0;
  for (const s of v.steps) {
    if (s.what === 'shows' || s.what.startsWith('check')) continue;
    const ord = ORDINALS[n % ORDINALS.length] + (n >= ORDINALS.length ? ' again' : '');
    n++;
    const text = s.what.startsWith('went wrong') ? `${ord}, the problem appears, and the user is left with the wrong result.` : `${ord}, the user carries on with the ${(s.target ?? 'page').toLowerCase()}.`;
    segments.push({ role: 'walk', text, from: s.id, to: s.id });
  }
  segments.push({ role: 'close', text: v.before ? 'That is the problem the change fixes.' : 'The user now gets what the ticket asks for.' });
  return { id: v.id, segments };
}

export function scriptedNarrator({ write = null, fail = null } = {}) {
  const tasks = [];
  const calls = [];
  const runAgent = (config, opts) => {
    tasks.push(opts.task);
    calls.push({ name: opts.name, mode: opts.mode, model: opts.model, usage: opts.usage });
    if (fail) return typeof fail === 'function' ? fail(opts) : fail;
    const videos = videosOfTask(opts.task).map((v) => (write ? write(v, tasks.length) ?? defaultScript(v) : defaultScript(v)));
    return { ok: true, status: 0, seconds: 1, usage: { costUsd: 0.01, tokens: 100 }, output: `Here are the scripts.\nAGENT_RESULT: ${JSON.stringify({ videos })}` };
  };
  return { runAgent, tasks, calls };
}
