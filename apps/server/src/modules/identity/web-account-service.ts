import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { identityKey } from "@lark-codex/contracts";
import { z } from "zod";
import { AppError } from "../../app-error.js";
import { withTransaction, type SqliteDatabase } from "../database/index.js";

const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/);
const Password = z.string().min(8).max(256);
export const CreateWebAccountSchema = z.strictObject({
  username: Username,
  name: z.string().trim().min(1).max(120),
  password: Password,
});
export const UpdateWebAccountSchema = z
  .strictObject({ password: Password.optional(), active: z.boolean().optional() })
  .refine((value) => value.password !== undefined || value.active !== undefined);
export const WebLoginSchema = z.strictObject({
  username: z.string().max(64),
  password: z.string().min(1).max(256),
});
const AccountRow = z.object({
  id: z.string(),
  passwordHash: z.string(),
  lockedUntil: z.number(),
  active: z.number(),
});

async function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
}

export class WebAccountService {
  private inFlight = 0;
  private windowStart = 0;
  private attempts = 0;
  constructor(
    private readonly database: SqliteDatabase,
    private readonly now = Date.now,
  ) {}

  list() {
    return this.database
      .prepare(
        `SELECT web_accounts.id, username, name, active FROM web_accounts
      JOIN identities ON identities.user_id = web_accounts.id AND identities.kind = 'web' ORDER BY username`,
      )
      .all();
  }
  enabled(): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM web_accounts JOIN identities ON identities.user_id = web_accounts.id
      WHERE identities.kind = 'web' AND active = 1 LIMIT 1`,
        )
        .get(),
    );
  }
  private audit(action: string, key: string | null, outcome: string) {
    this.database
      .prepare(
        `INSERT INTO audit_events(id, identity_key, action, resource_type, outcome, safe_metadata_json)
      VALUES (?, ?, ?, 'web_account', ?, '{}')`,
      )
      .run(randomUUID(), key, action, outcome);
  }
  async create(input: unknown) {
    const command = CreateWebAccountSchema.parse(input);
    const passwordHash = await hashPassword(command.password);
    const id = randomUUID();
    const key = identityKey({ kind: "web", accountId: id });
    withTransaction(this.database, () => {
      if (
        this.database.prepare("SELECT 1 FROM web_accounts WHERE username = ?").get(command.username)
      )
        throw new AppError("INVALID_REQUEST", 409, "账号名称已存在");
      this.database
        .prepare("INSERT INTO web_accounts(id, username, password_hash) VALUES (?, ?, ?)")
        .run(id, command.username, passwordHash);
      this.database
        .prepare(
          `INSERT INTO identities(identity_key, kind, user_id, name, role, active)
        VALUES (?, 'web', ?, ?, 'member', 1)`,
        )
        .run(key, id, command.name);
      this.audit("web_account.create", key, "allowed");
    });
    return { id, username: command.username, name: command.name, active: 1 };
  }
  async update(id: string, input: unknown) {
    z.uuid().parse(id);
    const command = UpdateWebAccountSchema.parse(input);
    const passwordHash =
      command.password === undefined ? undefined : await hashPassword(command.password);
    const key = identityKey({ kind: "web", accountId: id });
    withTransaction(this.database, () => {
      if (!this.database.prepare("SELECT 1 FROM web_accounts WHERE id = ?").get(id))
        throw new AppError("NOT_FOUND", 404, "账号不存在");
      if (passwordHash !== undefined)
        this.database
          .prepare(
            "UPDATE web_accounts SET password_hash = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?",
          )
          .run(passwordHash, id);
      if (command.active !== undefined)
        this.database
          .prepare("UPDATE identities SET active = ?, updated_at = ? WHERE identity_key = ?")
          .run(Number(command.active), new Date(this.now()).toISOString(), key);
      this.database
        .prepare("UPDATE sessions SET revoked_at = ? WHERE identity_key = ? AND revoked_at IS NULL")
        .run(new Date(this.now()).toISOString(), key);
      this.audit("web_account.update", key, "allowed");
    });
    return { id };
  }
  async verify(input: unknown): Promise<string> {
    const command = WebLoginSchema.parse(input);
    const now = this.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.attempts = 0;
    }
    // Do not trust forwarded IPs behind the public tunnel. Bound total KDF work as well as per-account guesses.
    if (this.inFlight >= 2 || this.attempts >= 30)
      throw new AppError("FORBIDDEN", 429, "尝试过于频繁，请稍后重试");
    this.attempts++;
    this.inFlight++;
    try {
      const row = AccountRow.safeParse(
        this.database
          .prepare(
            `SELECT id, password_hash AS passwordHash, locked_until AS lockedUntil, active
        FROM web_accounts JOIN identities ON identities.user_id = web_accounts.id AND identities.kind = 'web' WHERE username = ?`,
          )
          .get(command.username.trim().toLowerCase()),
      );
      const account = row.success ? row.data : null;
      const encoded =
        account?.passwordHash ?? `scrypt-v1$00000000000000000000000000000000$${"00".repeat(64)}`;
      const [, salt, expected] = encoded.split("$");
      const actual = await derive(command.password, salt!);
      const valid = timingSafeEqual(actual, Buffer.from(expected!, "hex"));
      // Re-read after the asynchronous KDF so a reset or disable cannot race into a fresh session.
      const current = account
        ? AccountRow.safeParse(
            this.database
              .prepare(
                `SELECT id, password_hash AS passwordHash, locked_until AS lockedUntil, active
        FROM web_accounts JOIN identities ON identities.user_id = web_accounts.id AND identities.kind = 'web' WHERE id = ?`,
              )
              .get(account.id),
          )
        : null;
      if (
        !account ||
        !valid ||
        !current?.success ||
        current.data.passwordHash !== encoded ||
        current.data.active !== 1 ||
        current.data.lockedUntil > this.now()
      ) {
        if (account && current?.success && current.data.lockedUntil <= this.now()) {
          this.database
            .prepare(
              `UPDATE web_accounts SET failed_attempts = CASE WHEN locked_until > 0 THEN 1 ELSE failed_attempts + 1 END,
            locked_until = CASE WHEN locked_until = 0 AND failed_attempts >= 4 THEN ? ELSE 0 END WHERE id = ?`,
            )
            .run(this.now() + 15 * 60_000, account.id);
        }
        this.audit(
          "web_account.login",
          account ? identityKey({ kind: "web", accountId: account.id }) : null,
          "denied",
        );
        throw new AppError("UNAUTHENTICATED", 401, "账号或密码错误，或账号暂不可用");
      }
      this.database
        .prepare("UPDATE web_accounts SET failed_attempts = 0, locked_until = 0 WHERE id = ?")
        .run(account.id);
      return account.id;
    } finally {
      this.inFlight--;
    }
  }
}
