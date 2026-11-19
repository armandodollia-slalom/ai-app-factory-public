function bad() {
  // ruleid: factory.ts.insecure-random-secret
  const resetToken = Math.random().toString(36).slice(2);
  return resetToken;
}

// ruleid: factory.ts.insecure-random-secret
const user = { apiKey: Math.random().toString(16) };

function makeSessionId() {
  // ruleid: factory.ts.insecure-random-secret
  return String(Math.random());
}

function good() {
  // ok: factory.ts.insecure-random-secret
  const jitterMs = Math.random() * 100;
  return jitterMs + crypto.randomUUID().length;
}
export { bad, user, makeSessionId, good };
