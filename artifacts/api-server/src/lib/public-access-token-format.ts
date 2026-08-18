const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function isPlausiblePublicAccessToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}
