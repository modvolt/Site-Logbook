import { useState, useCallback } from "react";
import { uploadObjectFile, type UploadMetadata } from "./upload-object-file";

export interface UploadResponse {
  /**
   * Legacy field from the presigned-PUT flow. With server-proxied uploads the
   * browser never sees a storage URL; this mirrors `objectPath` for callers
   * that still read it.
   */
  uploadURL: string;
  objectPath: string;
  metadata: UploadMetadata;
}

export interface UseUploadOptions {
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
        // Fetch itself does not expose byte-level upload progress, so the bar
        // remains pending until the API acknowledges the file. In return this
        // path now shares the mandatory identity, idempotency, and content
        // digest guard installed by the application before React mounts.
        const data = await uploadObjectFile(basePath, file);

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
    [basePath, options],
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
            errors.push(
              err instanceof Error ? err : new Error("Upload failed"),
            );
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
