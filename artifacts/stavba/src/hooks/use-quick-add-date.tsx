import { createContext, useContext, useState, type ReactNode } from "react";

type QuickAddDateContextValue = {
  /** yyyy-MM-dd to prefill a newly created job's date, or null for the default (today). */
  quickAddDate: string | null;
  setQuickAddDate: (date: string | null) => void;
};

const QuickAddDateContext = createContext<QuickAddDateContextValue | null>(null);

/**
 * Holds a date that the global "+" (quick add) FAB should prefill on a new job.
 * Only the calendar sets this (to the selected non-today day) and clears it on
 * unmount, so every other screen keeps the default "today" behaviour.
 */
export function QuickAddDateProvider({ children }: { children: ReactNode }) {
  const [quickAddDate, setQuickAddDate] = useState<string | null>(null);
  return (
    <QuickAddDateContext.Provider value={{ quickAddDate, setQuickAddDate }}>
      {children}
    </QuickAddDateContext.Provider>
  );
}

export function useQuickAddDate(): QuickAddDateContextValue {
  const ctx = useContext(QuickAddDateContext);
  if (!ctx) return { quickAddDate: null, setQuickAddDate: () => {} };
  return ctx;
}
