export interface UploadMetadata {
  name: string;
  size: number;
  contentType: string;
}

/**
 * Turn a non-2xx upload response into a precise, user-readable Czech message.
 *
 * Our own API answers errors as JSON `{ error }`; we surface that verbatim.
 * When the body is not JSON (e.g. an nginx/proxy HTML error page for a 413/502),
 * we strip the markup and keep a short snippet. The HTTP status is always
 * included so the exact problem is visible to the person on site.
 */
function describeUploadHttpError(status: number, responseText: string): string {
  let detail = "";
  try {
    const data = JSON.parse(responseText) as { error?: unknown };
    if (data && typeof data.error === "string") detail = data.error;
  } catch {
    // Non-JSON body (proxy error page, gateway HTML, …): keep a clean snippet.
    detail = (responseText || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  }

  // Status-specific hint when the body carried no usable detail.
  if (!detail) {
    if (status === 401) detail = "nejste přihlášeni (přihlaste se znovu)";
    else if (status === 403) detail = "nemáte oprávnění nahrávat soubory";
    else if (status === 413)
      detail = "soubor je příliš velký (překročen limit serveru nebo proxy)";
    else if (status === 415) detail = "tento typ souboru není povolen";
    else if (status === 502 || status === 503 || status === 504)
      detail = "server je dočasně nedostupný, zkuste to znovu";
    else detail = "neočekávaná chyba serveru";
  }

  return `Nahrávání selhalo (HTTP ${status}): ${detail}`;
}

/**
 * Upload one file through the application's same-origin fetch transport.
 *
 * The application installs its identity/idempotency guard on `window.fetch`
 * before React mounts. Keeping the raw upload on that transport ensures it
 * receives the same offline scope, idempotency key, and content digest as every
 * other private mutation.
 */
export async function uploadObjectFile(
  basePath: string,
  file: File,
  timeoutMs = 120_000,
): Promise<{ objectPath: string; metadata: UploadMetadata }> {
  const contentType = file.type || "application/octet-stream";
  const query = new URLSearchParams({
    name: file.name,
    contentType,
  });
  const endpoint = `${basePath}/uploads`;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await window.fetch(`${endpoint}?${query.toString()}`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: file,
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(describeUploadHttpError(response.status, responseText));
    }

    try {
      return JSON.parse(responseText) as {
        objectPath: string;
        metadata: UploadMetadata;
      };
    } catch {
      throw new Error("Nahrávání selhalo: neplatná odpověď serveru.");
    }
  } catch (error) {
    if (timedOut) {
      throw new Error(
        "Nahrávání selhalo: vypršel časový limit přenosu (pomalé připojení).",
      );
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Nahrávání bylo přerušeno.");
    }
    if (error instanceof TypeError) {
      throw new Error(
        `Nahrávání selhalo: server nelze kontaktovat (${endpoint}). ` +
          "Zkontrolujte připojení k internetu; pokud potíže trvají, server je nejspíš nedostupný.",
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
