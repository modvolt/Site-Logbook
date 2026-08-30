type BackupDatabaseEnvironment = Readonly<{
  BACKUP_DATABASE_URL?: string;
}>;

const REDACTED_BACKUP_DATABASE_URL = "[REDACTED_BACKUP_DATABASE_URL]";
const REDACTED_BACKUP_DATABASE_PASSWORD =
  "[REDACTED_BACKUP_DATABASE_PASSWORD]";

export function resolveBackupDatabaseUrl(
  environment: BackupDatabaseEnvironment = process.env,
): string {
  const databaseUrl = environment.BACKUP_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "BACKUP_DATABASE_URL is required for database backup creation.",
    );
  }
  return databaseUrl;
}

export function redactBackupDatabaseUrl(
  message: string,
  databaseUrl: string,
): string {
  let redacted = message.split(databaseUrl).join(REDACTED_BACKUP_DATABASE_URL);
  try {
    const password = new URL(databaseUrl).password;
    const decodedPassword = decodeURIComponent(password);
    for (const candidate of new Set([password, decodedPassword])) {
      if (candidate) {
        redacted = redacted
          .split(candidate)
          .join(REDACTED_BACKUP_DATABASE_PASSWORD);
      }
    }
  } catch {
    // The connection error stays useful while the supplied secret remains hidden.
  }
  return redacted;
}
