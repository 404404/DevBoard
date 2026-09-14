import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const manifestPath = resolve("apps/server/src/modules/codex/protocol-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function runCodex(arguments_) {
  const result = spawnSync("codex", arguments_, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `codex exited with ${result.status}`);
  }
  return result.stdout.trim();
}

function methods(definition) {
  return new Set(
    (definition?.oneOf ?? []).flatMap((entry) => entry?.properties?.method?.enum ?? []),
  );
}

function enumValues(definition) {
  return new Set((definition?.oneOf ?? []).flatMap((entry) => entry?.enum ?? []));
}

function assertContains(actual, expected, label) {
  const missing = expected.filter((value) => !actual.has(value));
  if (missing.length > 0) {
    throw new Error(`${label} 缺少：${missing.join(", ")}`);
  }
}

const versionOutput = runCodex(["--version"]);
const version = /codex-cli\s+(\S+)/.exec(versionOutput)?.[1];
if (version !== manifest.codexVersion) {
  throw new Error(
    `Codex 版本漂移：期望 ${manifest.codexVersion}，实际 ${version ?? versionOutput}`,
  );
}

const outputDirectory = mkdtempSync(join(tmpdir(), "lark-taskboard-codex-schema-"));
try {
  runCodex(["app-server", "generate-json-schema", "--out", outputDirectory]);
  const schema = JSON.parse(
    readFileSync(join(outputDirectory, "codex_app_server_protocol.schemas.json"), "utf8"),
  );
  const definitions = schema.definitions ?? {};
  assertContains(methods(definitions.ClientRequest), manifest.clientMethods, "ClientRequest");
  assertContains(
    methods(definitions.ClientNotification),
    manifest.clientNotifications,
    "ClientNotification",
  );
  assertContains(methods(definitions.ServerRequest), manifest.serverRequests, "ServerRequest");
  assertContains(
    methods(definitions.ServerNotification),
    manifest.serverNotifications,
    "ServerNotification",
  );
  for (const decisionType of ["CommandExecutionApprovalDecision", "FileChangeApprovalDecision"]) {
    assertContains(
      enumValues(definitions[decisionType]),
      manifest.oneShotApprovalDecisions,
      decisionType,
    );
  }
  process.stdout.write(`Codex App Server 协议检查通过（codex-cli ${manifest.codexVersion}）\n`);
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
