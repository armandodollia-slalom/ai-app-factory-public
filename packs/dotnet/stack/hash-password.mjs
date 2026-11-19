#!/usr/bin/env node
// Optional test stack helper for ASP.NET Core Identity: prints the V3 password hash a scenario stores in
// AspNetUsers.PasswordHash (PBKDF2-HMAC-SHA512, 100,000 iterations, 16-byte salt, 32-byte key), computed
// with node:crypto, so writing scenarios needs no .NET SDK. Register it as a test stack command with
//   "teststack": { "commands": { "hash-password": "pack:dotnet/stack/hash-password.mjs" } }
// or run it directly: node packs/dotnet/stack/hash-password.mjs '<password>'.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PRF_HMAC_SHA512 = 2;
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export function hashPassword(password, salt = crypto.randomBytes(SALT_BYTES)) {
  const header = Buffer.alloc(13);
  header.writeUInt8(0x01, 0);
  header.writeUInt32BE(PRF_HMAC_SHA512, 1);
  header.writeUInt32BE(ITERATIONS, 5);
  header.writeUInt32BE(salt.length, 9);
  return Buffer.concat([header, salt, crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_BYTES, 'sha512')]).toString('base64');
}

/** True when `hash` (any V3 hash: SHA1, SHA256 or SHA512 PRF) was made from `password`. */
export function verifyPassword(hash, password) {
  const bytes = Buffer.from(hash, 'base64');
  if (bytes.length < 13 || bytes[0] !== 0x01) return false;
  const digest = ['sha1', 'sha256', 'sha512'][bytes.readUInt32BE(1)];
  const iterations = bytes.readUInt32BE(5);
  const saltLength = bytes.readUInt32BE(9);
  if (!digest || bytes.length <= 13 + saltLength) return false;
  const salt = bytes.subarray(13, 13 + saltLength);
  const key = bytes.subarray(13 + saltLength);
  return crypto.timingSafeEqual(key, crypto.pbkdf2Sync(password, salt, iterations, key.length, digest));
}

/** Test stack command: `factory teststack hash-password <password>`. */
export default function command({ positionals }) {
  if (positionals.length !== 1) throw Object.assign(new Error('Usage: hash-password <password>'), { exitCode: 64 });
  return { hash: hashPassword(positionals[0]) };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, command: 'hash-password', ...command({ positionals: process.argv.slice(2) }) })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}
