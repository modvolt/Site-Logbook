import { useState, useCallback } from "react";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  onConfirm: () => void;
}

export function useConfirmDialog() {
  const [state, setState] = useState<ConfirmState | null>(null);

  const openConfirm = useCallback(
    (opts: ConfirmOptions | string, onConfirm: () => void) => {
      const options = typeof opts === "string" ? { title: opts } : opts;
      setState({ ...options, onConfirm });
    },
    [],
  );

  const dialogProps = {
    open: !!state,
    onOpenChange: (open: boolean) => {
      if (!open) setState(null);
    },
    title: state?.title ?? "",
    description: state?.description,
    confirmLabel: state?.confirmLabel,
    cancelLabel: state?.cancelLabel,
    destructive: state?.destructive,
    onConfirm: () => {
      state?.onConfirm();
      setState(null);
    },
  };

  return { openConfirm, dialogProps };
}
