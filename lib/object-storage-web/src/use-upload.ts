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
        setProgress(10);

        // Server-proxied upload: POST the raw file bytes to our own API (same
        // origin), which streams them into object storage. This avoids the old
        // direct browser→bucket PUT, which needed a bucket CORS rule and a
        // browser-reachable storage endpoint and failed at the network level
        // when either was misconfigured on a deployment.
        const contentType = file.type || "application/octet-stream";
        const query = new URLSearchParams({
          name: file.name,
          contentType,
        });

        let response: Response;
        try {
          response = await fetch(`${basePath}/uploads?${query.toString()}`, {
            method: "POST",
            headers: { "Content-Type": contentType },
            body: file,
          });
        } catch (err) {
          // A rejected fetch here is a network-level failure reaching our own
          // API (server down / no connectivity), not a storage/CORS problem.
          throw new Error(
            `Nahrávání selhalo: server je nedostupný (${
              err instanceof Error ? err.message : "network error"
            }).`,
          );
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error || `Nahrávání selhalo (HTTP ${response.status}).`,
          );
        }

        const data: { objectPath: string; metadata: UploadMetadata } =
          await response.json();

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
