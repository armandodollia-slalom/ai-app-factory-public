declare const db: any;
declare const id: string;

async function bad() {
  // ruleid: factory.ts.sql-string-built
  await db.query(`SELECT * FROM orders WHERE id = ${id}`);
  // ruleid: factory.ts.sql-string-built
  await db.execute("DELETE FROM carts WHERE owner = '" + id + "'");
  const q = "SELECT name FROM users WHERE id = " + id;
  // ruleid: factory.ts.sql-string-built
  await db.query(q);
}

async function good() {
  // ok: factory.ts.sql-string-built
  await db.query("SELECT * FROM orders WHERE id = $1", [id]);
  // ok: factory.ts.sql-string-built
  await db.query(`SELECT count(*) FROM orders`);
}

declare const request: any;
declare const base: string;

async function notSql() {
  // ok: factory.ts.sql-string-built
  await request.get(`${base}/api/catalog/items/${id}`);
  const itemUrl = `${base}/api/orders/${id}`;
  // ok: factory.ts.sql-string-built
  await request.get(itemUrl);
}
