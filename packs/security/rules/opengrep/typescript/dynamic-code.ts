import * as vm from "node:vm";
declare const body: { code: string };
declare function tick(): void;

function bad() {
  // ruleid: factory.ts.dynamic-code
  eval(body.code);
  const code = body.code;
  // ruleid: factory.ts.dynamic-code
  eval(code);
  // ruleid: factory.ts.dynamic-code
  const f = new Function("a", body.code);
  // ruleid: factory.ts.dynamic-code
  setTimeout("run(" + body.code + ")", 10);
  // ruleid: factory.ts.dynamic-code
  vm.runInNewContext(body.code, {});
  return f;
}

function good() {
  // ok: factory.ts.dynamic-code
  setTimeout(() => tick(), 10);
  // ok: factory.ts.dynamic-code
  setTimeout(tick, 10);
  // ok: factory.ts.dynamic-code
  eval("1 + 1");
}
