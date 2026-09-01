import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLoggerOptions } from "../src/logging.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("structured logging", () => {
  it("redacts credentials and payload-shaped fields", async () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "info" });
    const logger = { ...createLoggerOptions(config), stream };
    const app = buildApp({ config, logger });
    apps.push(app);

    const secrets = {
      authorization: "Bearer do-not-log-this",
      password: "password-do-not-log-this",
      body: { glucose: "health-value-do-not-log-this" },
      context: {
        credentials: { apiKey: "nested-api-key-do-not-log-this" },
        diary: { note: "nested-diary-note-do-not-log-this", notes: "legacy-notes-do-not-log" },
      },
    };
    app.log.info(secrets, "Redaction probe");
    await app.inject({
      method: "GET",
      url: "/health?query-value-must-not-be-logged",
      headers: { authorization: secrets.authorization },
    });

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(secrets.authorization);
    expect(output).not.toContain(secrets.password);
    expect(output).not.toContain(secrets.body.glucose);
    expect(output).not.toContain(secrets.context.credentials.apiKey);
    expect(output).not.toContain(secrets.context.diary.note);
    expect(output).not.toContain(secrets.context.diary.notes);
    expect(output).not.toContain("query-value-must-not-be-logged");
  });
});
