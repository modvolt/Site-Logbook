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
  properties: Record<string, boolean>;
  notes: string | null;
  status: string;
  processingStatus: string;
  assemblyStatus: string;
  inspectionStatus: string;
  measurementStatus: string;
  qrEnabled: boolean; qrTokenPrefix: string | null; qrExpiresAt: string | null;
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
export type SwitchboardExtractedField = {
  id: number; documentId: number; fieldKey: string; foundLabel: string; matchedAlias: string | null;
  rawValue: string | null; normalizedValue: string | null; correctedValue: string | null;
  effectiveValue: string | null; confidence: number; pageNumber: number; blockId: string | null;
  extractionMethod: string; relativeRelation: string; validationStatus: string;
  validationMessage: string | null; parserVersion: string; manuallyCorrected: boolean;
  correctedAt: string | null; createdAt: string;
};
export type SwitchboardExtractionDocument = SwitchboardDocument & { fields: SwitchboardExtractedField[]; missingFields: Array<{ fieldKey: string; canonicalNameCs: string; dataType: string }> };
export type SwitchboardLabel = { id: number; switchboardId: number; version: number; inputSnapshot: Record<string, unknown>; qrTarget: string; status: string; generatorVersion: string; createdAt: string; approvedAt: string | null };

export type SwitchboardChecklistResponse = {
  id: number; phaseKey: string; itemKey: string; result: "done" | "defect" | "not_applicable" | null;
  value: string | null; unit: string | null; passed: boolean | null; note: string | null; justification: string | null;
  revision: number; performedByUserId: number | null; performedByName: string | null;
  performedAt: string | null; updatedAt: string; pending?: boolean;
};
export type SwitchboardChecklistItem = {
  key: string; title: string; details: string[]; required: boolean; critical: boolean;
  kind: "check" | "measurement" | "photo";
  response: SwitchboardChecklistResponse | null;
};
export type SwitchboardChecklistPhase = {
  key: "assembly" | "inspection" | "measurement"; title: string; items: SwitchboardChecklistItem[];
  summary: { completed: number; total: number; defects: number; criticalDefects: number; status: string; lastWorker: string | null; lastChangedAt: string | null };
};
export type SwitchboardChecklist = {
  board: { id: number; properties: Record<string, boolean>; assemblyStatus: string; inspectionStatus: string; measurementStatus: string };
  instance: null | { id: number; currentPhase: "assembly" | "inspection" | "measurement"; revision: number; status: string; startedAt: string; updatedAt: string };
  phases: SwitchboardChecklistPhase[];
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
