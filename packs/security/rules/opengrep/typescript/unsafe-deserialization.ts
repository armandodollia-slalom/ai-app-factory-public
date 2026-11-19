declare const serialize: any;
declare const yaml: any;
declare const input: string;

function bad() {
  // ruleid: factory.ts.unsafe-deserialization
  serialize.unserialize(input);
  // ruleid: factory.ts.unsafe-deserialization
  yaml.unsafeLoad(input);
  // ruleid: factory.ts.unsafe-deserialization
  yaml.load(input, { schema: yaml.DEFAULT_FULL_SCHEMA });
}

function good() {
  // ok: factory.ts.unsafe-deserialization
  JSON.parse(input);
  // ok: factory.ts.unsafe-deserialization
  yaml.load(input);
}
