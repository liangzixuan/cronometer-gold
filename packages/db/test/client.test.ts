import { describe, expect, it } from "vitest";

import { createDatabaseFromEnvironment, hasDatabaseTlsQueryParameter } from "../src/index.js";

describe("database transport configuration", () => {
  it("fails closed unless production PostgreSQL verifies the server certificate", async () => {
    expect(() =>
      createDatabaseFromEnvironment({
        DATABASE_SSL_MODE: "disable",
        DATABASE_URL: "postgresql://database.invalid/nutrition",
        NODE_ENV: "production",
      }),
    ).toThrow("DATABASE_SSL_MODE=verify-full is required in production");

    const database = createDatabaseFromEnvironment({
      DATABASE_SSL_MODE: "verify-full",
      DATABASE_URL: "postgresql://database.invalid/nutrition",
      NODE_ENV: "production",
    });
    await database.destroy();
  });

  it.each([
    "ssl=0",
    "sslmode=disable",
    "sslcert=%2Ftmp%2Fclient.crt",
    "sslkey=%2Ftmp%2Fclient.key",
    "sslrootcert=%2Ftmp%2Froot.crt",
    "sslnegotiation=postgres",
    "uselibpqcompat=true&sslmode=require",
  ])("rejects connection-string TLS overrides before constructing a pool: %s", (query) => {
    expect(hasDatabaseTlsQueryParameter(`postgresql://database.invalid/nutrition?${query}`)).toBe(
      true,
    );
    expect(() =>
      createDatabaseFromEnvironment({
        DATABASE_SSL_MODE: "verify-full",
        DATABASE_URL: `postgresql://database.invalid/nutrition?${query}`,
        NODE_ENV: "production",
      }),
    ).toThrow("DATABASE_URL must not contain TLS query parameters");
  });
});
