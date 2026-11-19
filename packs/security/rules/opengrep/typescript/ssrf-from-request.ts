declare const app: any;
declare const axios: any;

app.post("/preview", async (req: any, res: any) => {
  // ruleid: factory.ts.ssrf-from-request
  const page = await fetch(req.body.url);
  // ruleid: factory.ts.ssrf-from-request
  const img = await axios.get(`https://${req.query.host}/logo.png`);
  // ok: factory.ts.ssrf-from-request
  const fixed = await fetch("https://catalog.internal/items");
  res.json({ page, img, fixed });
});
