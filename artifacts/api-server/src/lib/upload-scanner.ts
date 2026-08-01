const SCANNER_REQUIRED_TYPES = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export type UploadScanResult =
  | { verdict: "content_validated" | "clean" }
  | { verdict: "malicious" | "unavailable"; reason: string };

async function readLimitedScannerResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 8_192) {
      await reader.cancel();
      throw new Error("scanner response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/**
 * Optional fail-closed malware scanner adapter. Office containers require a
 * scanner; passive formats remain magic-validated when no adapter is configured.
 */
export async function scanUploadContent(
  body: Buffer,
  contentType: string,
  fileName: string,
): Promise<UploadScanResult> {
  const endpoint = process.env.UPLOAD_SCANNER_URL?.trim();
  if (!endpoint) {
    return SCANNER_REQUIRED_TYPES.has(contentType)
      ? { verdict: "unavailable", reason: "Pro tento typ souboru není dostupná antivirová kontrola." }
      : { verdict: "content_validated" };
  }

  try {
    const scannerUrl = new URL(endpoint);
    const localDevelopmentHttp =
      process.env.NODE_ENV !== "production" &&
      scannerUrl.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(scannerUrl.hostname);
    if (scannerUrl.protocol !== "https:" && !localDevelopmentHttp) {
      return { verdict: "unavailable", reason: "Scanner musí používat důvěryhodné HTTPS spojení." };
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "X-Upload-Content-Type": contentType,
      "X-Upload-File-Name": encodeURIComponent(fileName.slice(0, 255)),
    };
    const token = process.env.UPLOAD_SCANNER_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(scannerUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await readLimitedScannerResponse(response);
    if (!response.ok) {
      return { verdict: "unavailable", reason: `Scanner odpověděl HTTP ${response.status}.` };
    }
    const parsed = JSON.parse(text) as { verdict?: unknown };
    if (parsed.verdict === "clean") return { verdict: "clean" };
    if (parsed.verdict === "malicious") {
      return { verdict: "malicious", reason: "Scanner označil soubor jako škodlivý." };
    }
    return { verdict: "unavailable", reason: "Scanner vrátil neznámý výsledek." };
  } catch {
    return { verdict: "unavailable", reason: "Antivirová kontrola selhala nebo vypršel její časový limit." };
  }
}
