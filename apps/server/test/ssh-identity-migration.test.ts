import Database from "better-sqlite3";
import { expect, it } from "vitest";

import { migrateSshIdentityReferences } from "../src/modules/database/migrations/0029-ssh-identity-references.js";

it("clears stored paths and marks key-based Connections for explicit reconfiguration", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        auth_mode TEXT NOT NULL,
        identity TEXT,
        status TEXT NOT NULL,
        last_health_json TEXT,
        enabled INTEGER NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO connections VALUES
        ('key-host', 'identity_file', '/run/devboard/ssh/old-key', 'online',
          '{"status":"ready"}', 1, 4, 'old'),
        ('agent-host', 'agent', NULL, 'online', '{"status":"ready"}', 1, 2, 'old');
    `);

    migrateSshIdentityReferences(database);

    const columns = (database.pragma("table_info(connections)") as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns).toContain("identity_ref");
    expect(columns).not.toContain("identity");
    expect(database.prepare("SELECT * FROM connections WHERE id = 'key-host'").get()).toMatchObject(
      {
        identity_ref: null,
        status: "configuration_required",
        last_health_json: null,
        enabled: 0,
        version: 5,
      },
    );
    expect(
      database.prepare("SELECT * FROM connections WHERE id = 'agent-host'").get(),
    ).toMatchObject({
      identity_ref: null,
      status: "online",
      enabled: 1,
      version: 2,
    });
    expect(
      database
        .prepare("SELECT COUNT(*) FROM connections WHERE identity_ref = ?")
        .pluck()
        .get("/run/devboard/ssh/old-key"),
    ).toBe(0);
  } finally {
    database.close();
  }
});

it("drops legacy identity paths when a draft database has both columns", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        auth_mode TEXT NOT NULL,
        identity TEXT,
        identity_ref TEXT,
        status TEXT NOT NULL,
        last_health_json TEXT,
        enabled INTEGER NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO connections VALUES
        ('key-host', 'identity_file', '/old/private/key', '/run/devboard/ssh/identities/key',
          'online', '{"status":"ready"}', 1, 4, 'old'),
        ('configured-host', 'identity_file', NULL, 'host_ed25519', 'online', NULL, 1, 2, 'new');
    `);

    migrateSshIdentityReferences(database);

    const columns = (database.pragma("table_info(connections)") as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns).not.toContain("identity");
    expect(database.prepare("SELECT * FROM connections WHERE id = 'key-host'").get()).toMatchObject(
      {
        identity_ref: null,
        status: "configuration_required",
        enabled: 0,
        version: 5,
      },
    );
    expect(
      database.prepare("SELECT * FROM connections WHERE id = 'configured-host'").get(),
    ).toMatchObject({
      identity_ref: "host_ed25519",
      status: "online",
      enabled: 1,
      version: 2,
    });
  } finally {
    database.close();
  }
});

it("clears unsafe values in a draft identity_ref-only database", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        auth_mode TEXT NOT NULL,
        identity_ref TEXT,
        status TEXT NOT NULL,
        last_health_json TEXT,
        enabled INTEGER NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO connections VALUES
        ('key-host', 'identity_file', '/run/devboard/ssh/key', 'online', NULL, 1, 3, 'new');
    `);

    migrateSshIdentityReferences(database);

    expect(database.prepare("SELECT * FROM connections WHERE id = 'key-host'").get()).toMatchObject(
      {
        identity_ref: null,
        status: "configuration_required",
        enabled: 0,
        version: 4,
      },
    );
  } finally {
    database.close();
  }
});
