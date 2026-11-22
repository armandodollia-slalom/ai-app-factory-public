// Loaded into every test process by run.mjs: no test reaches a code host or any other server outside this machine. A
// fetch to anything but a loopback address fails at once (tests serve their fakes on 127.0.0.1 or inject a fetch).
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const real = globalThis.fetch;
if (real && process.env.FACTORY_TEST_ALLOW_NETWORK !== '1') {
  globalThis.fetch = (input, init) => {
    let host = '';
    try {
      host = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url).hostname;
    } catch {
      host = '';
    }
    if (!LOOPBACK.has(host)) return Promise.reject(new TypeError(`fetch failed: tests run offline (${host || 'no host'} is not this machine)`));
    return real(input, init);
  };
  globalThis.__factoryTestsOffline = true;
}
