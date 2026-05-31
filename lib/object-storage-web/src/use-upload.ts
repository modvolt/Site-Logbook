import { useState, useCallback } from "react";

interface UploadMetadata {
  name: string;
  size: number;
  contentType: string;
}

interface UploadResponse {
  /**
   * Legacy field from the presigned-PUT flow. With server-proxied uploads the
   * browser never sees a storage URL; this mirrors `objectPath` for callers
   * that still read it.
   */
  uploadURL: string;
  objectPath: string;
  metadata: UploadMetadata;
}

interface UseUploadOptions {
  /** Base path where object storage routes are mounted (default: "/api/storage") */
  basePath?: string;
  onSuccess?: (response: UploadResponse) => void;
  onError?: (error: Error) => void;
}

/**
 * React hook for server-proxied file uploads.
 *
 * The browser POSTs the raw file bytes to our own API (same origin, no bucket
 * CORS), which streams them into private object storage. Failures surface a
 * precise Czech reason (HTTP status + server/proxy detail, or a connectivity
 * hint) so the person on site can see the exact problem.
 *
 * @example
 * ```tsx
 * function FileUploader() {
 *   const { uploadFile, isUploading, error } = useUpload({
 *     onSuccess: (response) => {
 *       console.log("Uploaded to:", response.objectPath);
 *     },
 *   });
 *
 *   const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
 *     const file = e.target.files?.[0];
 *     if (file) {
 *       await uploadFile(file);
 *     }
 *   };
 *
 *   return (
 *     <div>
 *       <input type="file" onChange={handleFileChange} disabled={isUploading} />
 *       {isUploading && <p>Uploading...</p>}
 *       {error && <p>Error: {error.message}</p>}
 *     </div>
 *   );
 * }
 * ```
 */
/** Aggregate progress while a batch of files is uploading sequentially. */
interface BatchState {
  /** Total number of files in the current batch. */
  total: number;
  /** How many files have finished (succeeded or failed). */
  completed: number;
}

/** Outcome of a multi-file upload; one failure never aborts the rest. */
export interface BatchResult {
  succeeded: number;
  failed: number;
  /** Errors for the files that failed, in order of failure. */
  errors: Error[];
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

export function useUpload(options: UseUploadOptions = {}) {
  const basePath = options.basePath ?? "/api/storage";
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [progress, setProgress] = useState(0);
  const [batch, setBatch] = useState<BatchState | null>(null);

  const uploadFile = useCallback(
    async (file: File): Promise<UploadResponse> => {
      setIsUploading(true);
      setError(null);
      setProgress(0);

      try {
        // Server-proxied upload: POST the raw file bytes to our own API (same
        // origin), which streams them into object storage. This avoids the old
        // direct browser→bucket PUT, which needed a bucket CORS rule and a
        // browser-reachable storage endpoint and failed at the network level
        // when either was misconfigured on a deployment.
        //
        // Uses XMLHttpRequest (not fetch) so we can surface real byte-level
        // upload progress via `xhr.upload.onprogress` — fetch has no upload
        // progress events. On slow mobile connections this gives users on site
        // continuous feedback that a large photo is actually transferring.
        const contentType = file.type || "application/octet-stream";
        const query = new URLSearchParams({
          name: file.name,
          contentType,
        });
        const endpoint = `${basePath}/uploads`;

        const data = await new Promise<{
          objectPath: string;
          metadata: UploadMetadata;
        }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `${endpoint}?${query.toString()}`);
          xhr.setRequestHeader("Content-Type", contentType);
          // Fail a stalled transfer with a clear reason instead of hanging
          // forever. Matches the nginx proxy_read_timeout (120s) in production.
          xhr.timeout = 120_000;

          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              // Reserve the last 1% for the server's response so the bar only
              // hits 100% once the upload is actually acknowledged.
              const percent = Math.round((event.loaded / event.total) * 99);
              setProgress(percent);
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText));
              } catch {
                reject(new Error("Nahrávání selhalo: neplatná odpověď serveru."));
              }
              return;
            }
            reject(
              new Error(describeUploadHttpError(xhr.status, xhr.responseText)),
            );
          };

          // status 0 with onload never carrying a status means the request
          // never completed: server unreachable, DNS/TLS failure, the request
          // blocked (e.g. CORS / mixed-content), or the device went offline.
          // This is NOT a storage-bucket problem — the upload goes to our own
          // API on the same origin — so we point the user at connectivity.
          xhr.onerror = () => {
            reject(
              new Error(
                `Nahrávání selhalo: server nelze kontaktovat (${endpoint}). ` +
                  "Zkontrolujte připojení k internetu; pokud potíže trvají, server je nejspíš nedostupný.",
              ),
            );
          };

          // Fired only if a timeout is set; kept so a stalled transfer reports a
          // clear reason instead of a silent hang.
          xhr.ontimeout = () => {
            reject(
              new Error(
                "Nahrávání selhalo: vypršel časový limit přenosu (pomalé připojení).",
              ),
            );
          };

          xhr.onabort = () => {
            reject(new Error("Nahrávání bylo přerušeno."));
          };

          xhr.send(file);
        });

        setProgress(100);
        const uploadResponse: UploadResponse = {
          uploadURL: data.objectPath,
          objectPath: data.objectPath,
          metadata: data.metadata,
        };
        options.onSuccess?.(uploadResponse);
        return uploadResponse;
      } catch (err) {
        const error = err instanceof Error ? err : new Error("Upload failed");
        setError(error);
        options.onError?.(error);
        // Re-throw so callers can surface the specific reason to the user
        // (and log it). Previously this returned null, which collapsed every
        // distinct failure into one generic "upload failed" message.
        throw error;
      } finally {
        setIsUploading(false);
      }
    },
    [basePath, options]
  );

  /**
   * Upload several files one after another, reporting aggregate batch progress.
   *
   * Each file is handed to `processFile`, which is responsible for any
   * per-file preparation (resize/transcode), the actual `uploadFile` call, and
   * persisting the result (e.g. creating an attachment record). A failure on
   * one file is recorded and the batch continues with the remaining files, so a
   * single bad photo never aborts the whole upload.
   */
  const uploadFiles = useCallback(
    async (
      files: File[],
      processFile: (file: File, index: number) => Promise<void>,
    ): Promise<BatchResult> => {
      let succeeded = 0;
      let failed = 0;
      const errors: Error[] = [];
      setBatch({ total: files.length, completed: 0 });
      setProgress(0);
      try {
        for (let i = 0; i < files.length; i++) {
          try {
            await processFile(files[i], i);
            succeeded++;
          } catch (err) {
            failed++;
            errors.push(err instanceof Error ? err : new Error("Upload failed"));
          } finally {
            setBatch((b) =>
              b ? { total: b.total, completed: b.completed + 1 } : b,
            );
          }
        }
      } finally {
        setBatch(null);
        setProgress(0);
      }
      return { succeeded, failed, errors };
    },
    [],
  );

  // While a batch runs, the per-file `isUploading` flag flips between files;
  // `isBusy` stays true for the whole batch so the UI doesn't flicker. The
  // `displayProgress` blends finished files with the in-flight file's bytes.
  const isBusy = isUploading || batch !== null;
  const displayProgress = batch
    ? Math.min(
        100,
        Math.round(((batch.completed + progress / 100) / batch.total) * 100),
      )
    : progress;
  // Human-readable status: "Nahrávám 2/5" for multi-file batches, otherwise the
  // single-file byte percentage.
  const statusLabel =
    batch && batch.total > 1
      ? `Nahrávám ${Math.min(batch.completed + 1, batch.total)}/${batch.total}`
      : isBusy
        ? `Nahrávám… ${displayProgress}%`
        : null;

  return {
    uploadFile,
    uploadFiles,
    isUploading,
    error,
    progress,
    /** Aggregate batch state, or null when no batch is running. */
    batch,
    /** True for the whole duration of a single or multi-file upload. */
    isBusy,
    /** Combined 0–100 progress across the current batch (or single file). */
    displayProgress,
    /** Ready-to-render Czech status string, or null when idle. */
    statusLabel,
  };
}
