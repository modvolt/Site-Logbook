export type JobGroupSummary = {
  id: number;
  name: string;
  customerId: number | null;
  customerCompanyName: string | null;
  address: string | null;
  notes: string | null;
  status: string;
  dateFrom: string | null;
  dateTo: string | null;
  jobsCount: number;
  totalHours: number;
  materialTotalCost: number;
  jobNumbers: number[];
  sourceQuoteId: number | null;
  sourceQuoteNumber: string | null;
  sourceQuoteTitle: string | null;
  sourceInvoiceId: number | null;
  sourceQuoteJobId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type GroupTask = {
  id: number;
  jobId: number;
  title: string;
  description: string | null;
  done: boolean;
  isChangeRequest: boolean;
};

export type GroupMaterial = {
  id: number;
  jobId: number;
  name: string;
  quantity: number | null;
  unit: string | null;
  pricePerUnit: number | null;
  done: boolean;
};

export type GroupJob = {
  id: number;
  jobNumber: number | null;
  title: string;
  shortName: string | null;
  type: string;
  clientSite: string | null;
  date: string;
  startTime: string | null;
  status: string;
  customerId: number | null;
  groupId: number | null;
  notes: string | null;
  hoursSpent: number | null;
  hoursVasek: number | null;
  hoursJonas: number | null;
  price: number | null;
  transportCost: number | null;
  fines: number | null;
  parking: number | null;
  address: string | null;
  materials: GroupMaterial[];
  tasks: GroupTask[];
};

export type JobGroupDetail = JobGroupSummary & {
  jobs: GroupJob[];
};

export type JobListItem = {
  id: number;
  jobNumber: number | null;
  title: string;
  date: string;
  startTime: string | null;
  status: string;
  groupId?: number | null;
  customerId: number | null;
  customerCompanyName?: string | null;
  address: string | null;
  clientSite: string | null;
};

export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    let message = "Požadavek selhal.";
    try {
      const body = await response.json();
      if (typeof body?.message === "string") message = body.message;
    } catch {
      // Keep generic message.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function formatKc(value: number | null | undefined): string {
  return `${Math.round(value ?? 0).toLocaleString("cs-CZ")} Kč`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("cs-CZ");
}

export function materialLineTotal(material: GroupMaterial): number {
  return (material.quantity ?? 0) * (material.pricePerUnit ?? 0);
}
