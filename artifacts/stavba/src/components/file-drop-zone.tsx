import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { openFilePicker } from "@/lib/file-picker";

export function FileDropZone({
  onFiles,
  accept,
  multiple = true,
  disabled = false,
  label = "Přetáhněte soubory sem nebo klikněte pro výběr",
  className = "",
}: {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const emit = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    onFiles(multiple ? files : files.slice(0, 1));
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={() => !disabled && openFilePicker(inputRef.current)}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openFilePicker(inputRef.current);
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (disabled) return;
        emit(e.dataTransfer.files);
      }}
      className={`hidden md:flex flex-col items-center justify-center gap-2 w-full rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors cursor-pointer select-none ${
        over
          ? "border-primary bg-primary/5"
          : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/40"
      } ${disabled ? "opacity-50 pointer-events-none" : ""} ${className}`}
    >
      <Upload className={`w-6 h-6 ${over ? "text-primary" : "text-muted-foreground"}`} />
      <p className="text-sm text-muted-foreground">{label}</p>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          emit(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
