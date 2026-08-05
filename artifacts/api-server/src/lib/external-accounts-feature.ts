type ExternalAccountsEnvironment = {
  EXTERNAL_ACCOUNTS_ENABLED?: string;
};

/** Dark rollout: absent, malformed and differently-cased values stay disabled. */
export function externalAccountsEnabled(
  env: ExternalAccountsEnvironment = process.env,
): boolean {
  return env.EXTERNAL_ACCOUNTS_ENABLED === "true";
}
