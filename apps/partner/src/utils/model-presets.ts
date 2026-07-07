import type { CatalogModel, LLMProviderId } from "@/types";

export function modelDisplayLabel(
  _providerId: LLMProviderId,
  modelId: string,
  catalogModel?: CatalogModel,
): string {
  if (catalogModel?.displayName) return catalogModel.displayName;
  if (modelId.length <= 22) return modelId;
  return `${modelId.slice(0, 20)}…`;
}

export function providerDisplayLabel(providerId: LLMProviderId): string {
  return providerId;
}
