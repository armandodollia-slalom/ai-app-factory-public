import * as cp from "node:child_process";
import { exec, spawn } from "node:child_process";
declare const name: string;

function bad() {
  // ruleid: factory.ts.process-from-input
  cp.exec(`git log ${name}`);
  // ruleid: factory.ts.process-from-input
  exec("convert " + name + " out.png");
  // ruleid: factory.ts.process-from-input
  spawn(name, [], { shell: true });
}

function good() {
  // ok: factory.ts.process-from-input
  cp.exec("git status");
  // ok: factory.ts.process-from-input
  cp.execFile("git", ["log", name]);
  // ok: factory.ts.process-from-input
  spawn("git", ["log", name]);
  const re = /a(b)/;
  // ok: factory.ts.process-from-input
  re.exec(name);
}
