#!/usr/bin/env node
// Runs one council member detached from the stage that seated it, for a stage whose process ends with its round (the
// review runs in a Stop hook): `node council-member.mjs <job.json>`. The job names the repository, the stage's config
// folder, the agent run and the file the result goes to; the stage reads that file in the round, or, for a
// non-blocking member that finished late, in the next round as feedback (council.mjs runDetachedMember, takeLate).
import { writeText } from './lib/redact.mjs';
import fs from 'node:fs';
import { runAgentAsync } from './lib/agents.mjs';
import { loadConfig } from './lib/config.mjs';
import { agentEnv } from './lib/council.mjs';

const jobFile = process.argv[2];
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
let result;
try {
  const config = loadConfig(job.stage, job.root);
  const res = await runAgentAsync(config, { ...job.run, extraEnv: { ...(job.run.extraEnv ?? {}), ...agentEnv(job.memberEnv) } });
  result = { status: res.status, output: res.output ?? '', outage: res.outage ?? null, timedOut: Boolean(res.timedOut), ...(res.factoryGuard ? { factoryGuard: res.factoryGuard } : {}) };
} catch (error) {
  result = { status: 1, output: '', error: error.message };
}
writeText(`${job.out}.tmp`, JSON.stringify({ ...result, member: job.member, round: job.round, finishedAt: new Date().toISOString() }));
fs.renameSync(`${job.out}.tmp`, job.out);
fs.rmSync(jobFile, { force: true });
