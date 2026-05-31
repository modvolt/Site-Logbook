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
 * React hook for handling file uploads with presigned URLs.
 *
 * This hook implements the two-step presigned URL upload flow:
 * 1. Request a presigned URL from your backend (sends JSON metadata, NOT the file)
 * 2. Upload the file directly to the presigned URL
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

        const data = await new Promise<{
          objectPath: string;
          metadata: UploadMetadata;
        }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `${basePath}/uploads?${query.toString()}`);
          xhr.setRequestHeader("Content-Type", contentType);

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
            } else {
              let message = `Nahrávání selhalo (HTTP ${xhr.status}).`;
              try {
                const errorData = JSON.parse(xhr.responseText);
                if (errorData.error) message = errorData.error;
              } catch {
                // keep the generic HTTP-status message
              }
              reject(new Error(message));
            }
          };

          // A network-level failure reaching our own API (server down / no
          // connectivity), not a storage/CORS problem.
          xhr.onerror = () => {
            reject(
              new Error("Nahrávání selhalo: server je nedostupný (network error)."),
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
