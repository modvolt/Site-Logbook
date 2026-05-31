import { cn } from "@/lib/utils";

interface UploadProgressBarProps {
  /** Whether an upload is currently in progress. */
  isUploading: boolean;
  /** Byte-level progress 0–100. 0 while uploading means progress is not yet known. */
  progress: number;
  className?: string;
}

/**
 * A thin progress bar shown under an upload button while a file transfers.
 *
 * - Determinate: once real byte progress arrives (> 0) the bar fills 0→100%.
 * - Indeterminate: before any progress event (or when the connection can't
 *   report `lengthComputable`), it shows an animated sliding bar so the user
 *   still sees that something is happening.
 */
export function UploadProgressBar({
  isUploading,
  progress,
  className,
}: UploadProgressBarProps) {
  if (!isUploading) return null;

  const indeterminate = progress <= 0;

  return (
    <div
      className={cn(
        "relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-primary/20",
        className,
      )}
      role="progressbar"
      aria-label="Průběh nahrávání"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : progress}
    >
      {indeterminate ? (
        <div className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-primary animate-upload-indeterminate" />
      ) : (
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
          style={{ width: `${progress}%` }}
        />
      )}
    </div>
  );
}
