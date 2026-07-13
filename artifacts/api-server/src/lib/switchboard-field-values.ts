import type { ExtractedField } from "./switchboard-parser";

function valueMap(fields: Array<Pick<ExtractedField, "fieldKey" | "normalizedValue" | "validationStatus">>) {
  return new Map(fields
    .filter((field) => field.validationStatus === "valid" && field.normalizedValue)
    .map((field) => [field.fieldKey, field.normalizedValue!]));
}

export function switchboardPatchFromExtractedFields(
  fields: Array<Pick<ExtractedField, "fieldKey" | "normalizedValue" | "validationStatus">>,
) {
  const values = valueMap(fields);
  const value = (key: string) => values.get(key);
  const standard = value("standard");
  return {
    ...(value("boardDesignation") ? { designation: value("boardDesignation") } : {}),
    ...(value("serialNumber") ? { serialNumber: value("serialNumber") } : {}),
    ...(value("productionDate") ? { productionDate: value("productionDate") } : {}),
    ...(value("typeDesignation") ? { typeDesignation: value("typeDesignation") } : {}),
    ...(value("networkSystem") ? { networkSystem: value("networkSystem") } : {}),
    ...(value("ratedVoltage") ? { ratedVoltage: value("ratedVoltage") } : {}),
    ...(value("ratedFrequency") ? { ratedFrequency: value("ratedFrequency") } : {}),
    ...(value("ratedCurrent") ? { ratedCurrent: value("ratedCurrent") } : {}),
    ...(value("dimensions") ? { dimensions: value("dimensions") } : {}),
    ...(value("weight") ? { weight: value("weight") } : {}),
    ...(value("ipRating") ? { ipRating: value("ipRating") } : {}),
    ...(value("ikRating") ? { ikRating: value("ikRating") } : {}),
    ...(standard ? { standards: standard.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean) } : {}),
  };
}
