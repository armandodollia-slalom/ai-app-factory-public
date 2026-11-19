import * as fs from "node:fs";
import * as path from "node:path";
declare const app: any;

app.get("/files/:name", (req: any, res: any) => {
  // ruleid: factory.ts.path-from-request
  const text = fs.readFileSync(path.join("/srv/files", req.params.name), "utf8");
  // ruleid: factory.ts.path-from-request
  res.sendFile(req.query.file);
  // ok: factory.ts.path-from-request
  const safe = fs.readFileSync(path.join("/srv/files", path.basename(req.params.name)), "utf8");
  // ok: factory.ts.path-from-request
  const fixed = fs.readFileSync("/srv/files/index.txt", "utf8");
  res.send(text + safe + fixed);
});
