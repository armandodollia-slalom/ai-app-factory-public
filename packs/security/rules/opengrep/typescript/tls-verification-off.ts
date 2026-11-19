import * as https from "node:https";

// ruleid: factory.ts.tls-verification-off
const agent = new https.Agent({ rejectUnauthorized: false });
// ruleid: factory.ts.tls-verification-off
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// ok: factory.ts.tls-verification-off
const safe = new https.Agent({ rejectUnauthorized: true, keepAlive: true });
export { agent, safe };
