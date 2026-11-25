import { activeStory, resolveStory } from './stories.mjs';
import { setting } from './settings.mjs';

export function parseArgs(argv, valueFlags = new Set()) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) flags[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--') && valueFlags.has(key)) flags[key] = argv[++i];
    else flags[key] = true;
  }
  return { positional, flags };
}

// Hook payloads arrive on a pipe or a socket. Read it as a stream: fs.readFileSync(0) after touching
// process.stdin (isTTY) sees a non-blocking socket and throws EAGAIN on payloads over the socket buffer
// (about 8 kB), which used to be read as "no payload".
export async function readStdin(stream = process.stdin) {
  if (stream.isTTY) return '';
  let text = '';
  stream.setEncoding?.('utf8');
  for await (const chunk of stream) text += chunk;
  return text;
}

// The hook payload, strictly: { payload } or { error } (unreadable, or not a JSON object). Guard decisions use
// this and fail closed on an error.
export async function readPayloadStrict(stream = process.stdin) {
  let text;
  try {
    text = await readStdin(stream);
  } catch (error) {
    return { error: `the tool call could not be read (${error.code ?? error.message})` };
  }
  if (!text.trim()) return { payload: {}, empty: true };
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'the tool call is not a JSON object' };
    if (payload.__factory_unreadable) return { error: `the tool call could not be read upstream (${payload.__factory_unreadable})` };
    return { payload };
  } catch (error) {
    return { error: `the tool call is not valid JSON (${error.message.slice(0, 80)}; ${text.length} bytes)` };
  }
}

// For events that only inform (stop, session start): a payload that cannot be read is an empty one.
// Only code agents' stops are reviewed and checked: the main session (Stop) or a subagent whose type is listed in
// hooks.codeAgents (SubagentStop), for the architecture review and the automatic PR check alike. Pipeline child agents
// never reach the hooks (PIPELINE_CHILD).
export function isCodeAgentStop(config, payload = {}) {
  if (payload.hook_event_name !== 'SubagentStop' || !payload.agent_type) return true;
  return setting(config, 'hooks.codeAgents').includes(payload.agent_type);
}

export async function readPayload() {
  const r = await readPayloadStrict();
  return r.payload ?? {};
}

// A story by key (fetched from the board when not cached; `update` re-checks the board), else the
// active story with `fallbackActive`. Exits 2 when there is none.
export function requireStory(config, arg, { fallbackActive = false, update = false } = {}) {
  const story = arg ? resolveStory(config, arg, { update }) : fallbackActive ? activeStory(config) : null;
  if (!story) {
    console.error(
      arg
        ? `Unknown story "${arg}": it is not in the ticket cache and could not be fetched from the board (\`factory board fetch ${arg}\` shows why).`
        : 'No story given and no active story (run `factory start <story>` or use a branch named after the story).',
    );
    process.exit(2);
  }
  return story;
}

// Hooks must never break the agent or git: on a crash the stop hook surfaces the error as a message
// and every hook exits 0.
// Exits once stdout and stderr have handed everything to the OS: process.exit drops what is still queued for a pipe,
// so a large JSON result read by another process was cut at 8 KiB (`retro run --dry-run --since all`).
export const exitFlushed = (code) => process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));

export function runMain(main, tag) {
  main().then(
    (code) => exitFlushed(code ?? 0),
    (error) => {
      const [command, event] = process.argv.slice(2);
      if (command === 'hook' || (command === 'git-hook' && event !== 'pre-push')) {
        if (event === 'stop') process.stdout.write(JSON.stringify({ systemMessage: `${tag} hook error: ${error.message}` }));
        else console.error(`[${tag}] hook error: ${error.message}`);
        process.exit(0);
      }
      // A configuration that does not load is the user's to fix: its message says what, a stack trace adds nothing.
      console.error(error?.code === 'config' ? `${tag}: ${error.message}` : (error.stack ?? error.message));
      process.exit(1);
    },
  );
}
