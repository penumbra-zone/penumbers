import { Database } from "./schema";
import pkg from "pg";
const { Pool } = pkg;
import { Kysely, PostgresDialect } from "kysely";

const dialect = new PostgresDialect({
  pool: new Pool({ connectionString: process.env["DB_URL"] }),
});

export const db = new Kysely<Database>({ dialect });
