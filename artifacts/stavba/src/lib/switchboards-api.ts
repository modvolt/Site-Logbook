export type SwitchboardAssignee = {
  id: number;
  personId: number;
  personName: string;
  isResponsible: boolean;
  assignedAt: string;
};

export type Switchboard = {
  id: number;
  jobId: number;
  internalName: string;
  designation: string;
  installationLocation: string | null;
  serialNumber: string | null;
  productionDate: string | null;
  typeDesignation: string | null;
  manufacturer: string;
  networkSystem: string | null;
  ratedVoltage: string | null;
  ratedFrequency: string | null;
  ratedCurrent: string | null;
  ipRating: string | null;
  ikRating: string | null;
  dimensions: string | null;
  weight: string | null;
  standards: string[];
  notes: string | null;
  status: string;
  processingStatus: string;
  assemblyStatus: string;
  inspectionStatus: string;
  measurementStatus: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  job: { id: number; title: string; jobNumber: number | null } | null;
  assignees: SwitchboardAssignee[];
};

export type SwitchboardDocument = {
  id: number; switchboardId: number; documentType: string; version: number;
  originalFileName: string; mimeType: string; sha256: string; sizeBytes: number;
  isPublic: boolean; processingStatus: string; processingErrorCode: string | null;
  processingErrorMessage: string | null; uploadedAt: string;
};

export async function switchboardFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error || `Server vrátil chybu ${response.status}.`);
  return body as T;
}

export const SWITCHBOARD_STATUS_LABELS: Record<string, string> = {
  created: "Založen",
  documentation_uploaded: "Dokumentace nahrána",
  assembly: "Probíhá sestavení",
  wiring: "Probíhá zapojení",
  awaiting_inspection: "Čeká na kontrolu",
  inspection: "Probíhá kontrola",
  awaiting_measurement: "Čeká na měření",
  measurement: "Probíhá měření",
  defects_found: "Zjištěny závady",
  defects_resolved: "Závady odstraněny",
  protocol_completed: "Protokol dokončen",
  ready_for_handover: "Připraven k předání",
  handed_over: "Předán",
  service: "Servisní režim",
  archived: "Archivován",
};
