#!/usr/bin/env node
// `factory sink`: the remote store for the agents' observability data (scripts/pipeline/lib/sink.mjs).
import { loadConfig } from '../pipeline/lib/config.mjs';
import { KNOWN_STREAMS, pull, push, sinkAdapter, sinkSettings, SINK_TYPES, status } from '../pipeline/lib/sink.mjs';

const USAGE = `Usage: factory sink <command>

  status                 which service is configured, what it can do, what is waiting to be shipped
  push                   ship the records each .factory/metrics stream gained since the last push
  pull [--since <iso>]   bring the store's records into the local cache (the retro does this itself)
  test                   send one test record (and read it back when the service can be read)

Configure the service in .factory/config.json under metrics.sink (types: ${Object.keys(SINK_TYPES).join(', ')}),
or let the setup-observability skill do it. Secrets are written as \${ENV_VAR} and read from the environment.`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const since = rest.includes('--since') ? rest[rest.indexOf('--since') + 1] : null;
  if (!command || command === 'help' || command === '--help') return console.log(USAGE), 0;
  const config = loadConfig();
  switch (command) {
    case 'status': {
      const s = status(config);
      console.log(`Sink: ${s.type} (project "${s.project}"). Push: ${s.canPush ? 'yes' : 'no'}. Read back (needed by the retro): ${s.canPull ? 'yes' : 'no'}.`);
      const pending = Object.entries(s.pendingBytes);
      console.log(pending.length ? `Waiting to be shipped: ${pending.map(([f, n]) => `${f} (${n} bytes)`).join(', ')}.` : 'Nothing is waiting to be shipped.');
      if (s.lastPull) console.log(`Last pull: ${s.lastPull.at}${s.lastPull.since ? ` (records since ${s.lastPull.since})` : ''}.`);
      if (s.type !== 'none' && !s.canPull) console.log('This service cannot be read back, so the retro sees only this checkout\'s records. Add a store that can (directory, http, or a command sink with a pull command) if retros should cover other machines or repositories.');
      return 0;
    }
    case 'push': {
      const r = await push(config);
      if (r.skipped) return console.log(`Nothing shipped: ${r.skipped}.`), 0;
      console.log(`Shipped ${r.shipped} record(s).`);
      for (const [stream, s] of Object.entries(r.streams)) console.log(`  ${stream}: ${s.error ? `FAILED after ${s.shipped} (${s.error})` : s.shipped}`);
      return r.failed ? 1 : 0;
    }
    case 'pull': {
      const r = await pull(config, { since });
      if (r.skipped) return console.log(`Nothing pulled: ${r.skipped}.`), 0;
      console.log(`Pulled ${r.pulled} record(s) into the local cache.`);
      for (const [stream, s] of Object.entries(r.streams)) console.log(`  ${stream}: ${s.error ? `FAILED (${s.error})` : s.pulled}`);
      return r.failed ? 1 : 0;
    }
    case 'test': {
      const settings = sinkSettings(config);
      const adapter = sinkAdapter(config);
      if (!adapter) return console.log('No sink is configured (metrics.sink.type is "none").'), 1;
      const ts = new Date().toISOString();
      const record = { _id: `test-${Date.now()}`, _project: settings.project, _stream: 'sink-test', _host: 'test', ts, test: true };
      await adapter.push('sink-test.jsonl', [record]);
      console.log(`Sent one test record to the ${settings.type} sink.`);
      if (settings.canPull) {
        const back = await adapter.pull('sink-test.jsonl', new Date(Date.parse(ts) - 60_000).toISOString());
        const found = back.some((r) => r._id === record._id);
        console.log(found ? 'Read it back: the retro can use this service.' : `Could not read it back (${back.length} record(s) returned): check the pull side before relying on it for retros.`);
        return found ? 0 : 1;
      }
      console.log('This service cannot be read back; check there that the record arrived.');
      return 0;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 64;
  }
}
void KNOWN_STREAMS;
main().then((code) => { process.exitCode = code; }, (error) => { console.error(`factory sink: ${error.message}`); process.exitCode = 1; });
