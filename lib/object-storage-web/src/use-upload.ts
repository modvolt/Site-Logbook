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
export function useUpload(options: UseUploadOptions = {}) {
  const basePath = options.basePath ?? "/api/storage";
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [progress, setProgress] = useState(0);

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

  return {
    uploadFile,
    isUploading,
    error,
    progress,
  };
}
