export const WEB_CLI_AUTH_VERSION_SQL = `
ALTER TABLE web_accounts ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0
  CHECK (auth_version >= 0);
`;
