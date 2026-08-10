export function markCurrentDocumentAsDuplicate(
  currentDocumentId: number,
  primaryDocumentId: number,
) {
  return {
    id: currentDocumentId,
    data: { primaryDocumentId },
  };
}
