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
  openDefectCount: number;
  criticalOpenDefectCount: number;
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
  valueCandidates: Array<{ raw: string; normalized: string | null; relation: string; score: number; valid: boolean; message: string | null }>;
  correctedAt: string | null; createdAt: string;
};
export type SwitchboardExtractionDocument = SwitchboardDocument & { fields: SwitchboardExtractedField[]; missingFields: Array<{ fieldKey: string; canonicalNameCs: string; dataType: string }> };
export type SwitchboardLabel = { id: number; switchboardId: number; version: number; inputSnapshot: Record<string, unknown>; qrTarget: string; status: string; generatorVersion: string; createdAt: string; approvedAt: string | null };
export type SwitchboardDocumentComparison = {
  from: { id: number; version: number; originalFileName: string; sha256: string; processingStatus: string; uploadedAt: string };
  to: { id: number; version: number; originalFileName: string; sha256: string; processingStatus: string; uploadedAt: string };
  changes: Array<{ fieldKey: string; canonicalNameCs: string; before: { effectiveValue: string | null; confidence: number } | null; after: { effectiveValue: string | null; confidence: number } | null }>;
};
export type SwitchboardLabelComparison = {
  from: { id: number; version: number; status: string; generatorVersion: string; sourceDocumentId: number | null; sourceDocumentVersion: number | null; createdAt: string; approvedAt: string | null };
  to: { id: number; version: number; status: string; generatorVersion: string; sourceDocumentId: number | null; sourceDocumentVersion: number | null; createdAt: string; approvedAt: string | null };
  changes: Array<{ fieldKey: string; before: unknown; after: unknown }>;
};

export type SwitchboardFieldRegistry = {
  id: number; fieldKey: string; canonicalNameCs: string; aliases: string[]; dataType: string;
  required: boolean; minimumConfidence: number; labelOrder: number; protocolOrder: number;
  isActive: boolean; createdAt: string; updatedAt: string;
};

export type SwitchboardChecklistDefinitionItem = {
  key: string; title: string; details: string[]; required: boolean; critical: boolean;
  kind: "check" | "measurement" | "photo";
  relevance?: { property: string; equals: boolean };
};
export type SwitchboardChecklistDefinition = {
  schemaVersion: 1;
  phases: Array<{ key: "assembly" | "inspection" | "measurement"; title: string; items: SwitchboardChecklistDefinitionItem[] }>;
};
export type SwitchboardChecklistTemplateVersion = {
  id: number; templateId: number; version: number; definition: SwitchboardChecklistDefinition;
  createdByUserId: number | null; createdAt: string;
};
export type SwitchboardChecklistTemplate = {
  id: number; name: string; boardType: string | null; isActive: boolean;
  createdByUserId: number | null; createdAt: string; updatedAt: string;
  versions: SwitchboardChecklistTemplateVersion[];
};

export type SwitchboardEvent = {
  id: number; switchboardId: number | null; eventType: string; entityType: string; entityId: number | null;
  payload: Record<string, unknown>; actorUserId: number | null; actorName: string | null; createdAt: string;
  board: null | { id: number; designation: string | null; internalName: string | null; job: null | { id: number; jobNumber: number | null; title: string | null } };
};
export type SwitchboardEventPage = { items: SwitchboardEvent[]; total: number; eventTypes: string[] };

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
  instance: null | { id: number; currentPhase: "assembly" | "inspection" | "measurement"; revision: number; status: string; startedAt: string; completedAt: string | null; updatedAt: string };
  phases: SwitchboardChecklistPhase[];
};

export type SwitchboardMeasurement = {
  id: number; switchboardId: number; checklistResponseId: number | null; checklistItemKey: string | null;
  phaseKey: string | null; measurementType: string; subjectLabel: string | null; value: number | null;
  valueText: string | null; unit: string; result: "pass" | "fail"; instrument: string | null;
  note: string | null; measuredByUserId: number | null; measuredByName: string | null; measuredAt: string;
};
export type SwitchboardDefect = {
  id: number; switchboardId: number; checklistResponseId: number | null; checklistItemKey: string | null;
  phaseKey: string | null; title: string; description: string | null; severity: string; isCritical: boolean;
  status: "open" | "in_repair" | "closed"; responsiblePersonId: number | null; responsiblePersonName: string | null;
  dueDate: string | null; repairDescription: string | null; foundByName: string | null; foundAt: string;
  closedByName: string | null; closedAt: string | null;
};
export type SwitchboardPhoto = {
  id: number; switchboardId: number; category: string; relatedType: string | null; relatedId: number | null;
  phaseKey: string | null; checklistItemKey: string | null; originalFileName: string; mimeType: string;
  sizeBytes: number; sha256: string; description: string | null; uploadedByName: string | null;
  takenAt: string | null; createdAt: string; contentUrl: string;
};
export type SwitchboardOperations = { measurements: SwitchboardMeasurement[]; defects: SwitchboardDefect[]; photos: SwitchboardPhoto[] };

export type SwitchboardProtocolBlocker = { code: string; message: string; phaseKey?: string; itemKey?: string };
export type SwitchboardProtocolReadiness = { ready: boolean; blockers: SwitchboardProtocolBlocker[] };
export type SwitchboardProtocol = {
  id: number; switchboardId: number; version: number; protocolNumber: string; generatorVersion: string;
  status: "generating" | "final" | "failed"; createdByUserId: number | null; createdByName: string | null;
  createdAt: string; downloadUrl: string | null;
};

export async function uploadSwitchboardPhoto(switchboardId: number, file: File | Blob, metadata: Record<string, string>) {
  const name = file instanceof File ? file.name : "fotografie.jpg";
  const contentType = file.type || "image/jpeg";
  const query = new URLSearchParams({ ...metadata, name, contentType });
  const response = await fetch(`/api/switchboards/${switchboardId}/photos?${query}`, { method: "POST", headers: { "Content-Type": contentType }, body: file });
  const body = await response.json().catch(() => null) as { error?: string; operations?: SwitchboardOperations } | null;
  if (!response.ok) throw new Error(body?.error || `Nahrání fotografie selhalo (${response.status}).`);
  return body!;
}

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
