import * as crypto from "node:crypto";
declare const key: Buffer;
declare const iv: Buffer;

// ruleid: factory.ts.weak-crypto
crypto.createHash("md5").update("x").digest("hex");
// ruleid: factory.ts.weak-crypto
crypto.createHash("sha1");
// ruleid: factory.ts.weak-crypto
crypto.createCipheriv("aes-128-ecb", key, null);
// ruleid: factory.ts.weak-crypto
crypto.createCipheriv("des-ede3-cbc", key, iv);
// ok: factory.ts.weak-crypto
crypto.createHash("sha256");
// ok: factory.ts.weak-crypto
crypto.createCipheriv("aes-256-gcm", key, iv);
