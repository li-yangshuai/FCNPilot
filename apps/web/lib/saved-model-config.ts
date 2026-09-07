import { isDeepStrictEqual } from "node:util";

export interface SavedConfigSelection<T> {
  value?: T;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutModels(provider: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(provider).filter(([key]) => key !== "models"),
  );
}

/**
 * Select a provider only from persisted models.json data. The submitted copy is
 * deliberately used only as a stale-draft check: it must never become input to
 * ModelRuntime or fetch, because ModelRuntime expands $ENV values in providers.
 */
export function selectSavedProvider(
  config: Record<string, unknown>,
  providerName: string,
  submittedProvider: Record<string, unknown>,
): SavedConfigSelection<Record<string, unknown>> {
  if (!isRecord(config.providers) || !Object.hasOwn(config.providers, providerName)) {
    return { error: `Save provider "${providerName}" before using it` };
  }

  const savedProvider = config.providers[providerName];
  if (!isRecord(savedProvider)) {
    return { error: `Saved provider "${providerName}" is invalid` };
  }

  if (!isDeepStrictEqual(withoutModels(savedProvider), withoutModels(submittedProvider))) {
    return { error: `Provider "${providerName}" has unsaved changes; save it and try again` };
  }

  return { value: savedProvider };
}

/** Select an exact saved model definition; submitted draft fields are not trusted. */
export function selectSavedModel(
  savedProvider: Record<string, unknown>,
  modelId: string,
  submittedModel: Record<string, unknown>,
): SavedConfigSelection<Record<string, unknown>> {
  const savedModel = Array.isArray(savedProvider.models)
    ? savedProvider.models.find((model) => (
      isRecord(model)
      && typeof model.id === "string"
      && model.id.trim() === modelId
    ))
    : undefined;

  if (!isRecord(savedModel)) {
    return { error: `Save model "${modelId}" before testing it` };
  }
  if (!isDeepStrictEqual(savedModel, submittedModel)) {
    return { error: `Model "${modelId}" has unsaved changes; save it and try again` };
  }

  return { value: savedModel };
}
