import { defineConfig } from "drizzle-kit";

// Demo: embedded PGlite. Production: set DATABASE_URL and switch dialect
// credentials to a PostgreSQL server — the generated SQL is portable.
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
});
