import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/ledger/schema.ts",
  out: "./drizzle",
});
