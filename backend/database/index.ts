import pkg from "pg";
const { Pool, types } = pkg;
import { Kysely, PostgresDialect } from "kysely";
import { Schema } from "./schema";

const dialect = new PostgresDialect({
  pool: new Pool({ connectionString: process.env["DB_URL"] }),
});

export type Database = Kysely<Schema>;
export type { Schema } from "./schema";

export const db = new Kysely<Schema>({ dialect });

const int8TypeId = 20;
// Map int8 to number.
types.setTypeParser(int8TypeId, (val) => {
  return BigInt(val);
});
