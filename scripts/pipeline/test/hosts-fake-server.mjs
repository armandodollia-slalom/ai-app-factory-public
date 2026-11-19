// Runs the fake GitLab and Azure DevOps servers in their own process, for tests of the synchronous bridge
// (a synchronous call blocks its own process, so the server cannot live there). Prints one JSON line
// with their URLs, then serves until killed.
import { fakeAzure, fakeGitlab } from './hosts-fakes.mjs';

const gl = await fakeGitlab('/gitlab');
const az = await fakeAzure('/tfs');
gl.state.addMr();
az.state.addPr();
process.stdout.write(`${JSON.stringify({ gitlab: gl.url, azure: az.url })}\n`);
