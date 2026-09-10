import { stat } from "fs/promises";
import { join, resolve } from "path";
import {
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAccountPreferences } from "@/lib/account-preferences";
import { getCurrentAccountUid } from "@/lib/accounts";
import {
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
  type ModelsData,
} from "@/lib/models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "@/lib/model-scope";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { projectTrustReloadOptions } from "@/lib/project-trust";

export const dynamic = "force-dynamic";

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelEntries(
  a: { id: string; name: string; provider: string },
  b: { id: string; name: string; provider: string },
): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

async function loadModels(
  cwd: string,
  agentDir: string,
  sharedAgentDir: string,
): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  // Resources/settings come from the selected Agent suite. Credentials and
  // models.json remain shared with the Pi CLI and every Web account.
  const modelRuntime = await ModelRuntime.create({
    authPath: join(sharedAgentDir, "auth.json"),
    modelsPath: join(sharedAgentDir, "models.json"),
  });
  const trustReloadOptions = projectTrustReloadOptions(cwd, sharedAgentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const modelError = services.modelRuntime.getError();
  const settings: SettingsManager = services.settingsManager;
  const scope = await resolveVisibleModels(
    services.modelRuntime,
    settings.getEnabledModels(),
  );
  const { visible, thinkingLevelPins, warnings } = scope;
  const modelList = visible.map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    input: [...model.input],
  })).sort(compareModelEntries);
  for (const model of visible) {
    const key = `${model.provider}:${model.id}`;
    nameMap.set(key, model.name);
    thinkingLevels[key] = getSupportedThinkingLevels(model);
    if (model.thinkingLevelMap) thinkingLevelMaps[key] = model.thinkingLevelMap;
  }

  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const initial = selectInitialModelScope(scope, {
    ...(defaultProvider && defaultModelId
      ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
      : {}),
  });
  const defaultModel = initial.model
    ? { provider: initial.model.provider, modelId: initial.model.id }
    : null;

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins,
      ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {}),
    },
    modelError,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

export async function GET(req: Request) {
  const accountUid = await getCurrentAccountUid();
  if (!accountUid) return Response.json({ error: "Not logged in" }, { status: 401 });

  const preferences = getAccountPreferences(accountUid);
  const requestedCwd = new URL(req.url).searchParams.get("cwd") || process.cwd();
  const cwd = resolve(requestedCwd);
  const allowedRoots = await getAllowedFileRoots(accountUid, cwd);
  if (!isFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "cwd is outside this account's allowed workspaces" }, { status: 403 });
  }

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const sharedAgentDir = getAgentDir();
  const agentDir = getAgentDir();
  const cacheKey = `${accountUid}\0${agentDir}\0${cwd}`;
  try {
    const models = await loadModelsWithCache(
      cacheKey,
      () => loadModels(cwd, agentDir, sharedAgentDir),
    );
    const preferredModel = preferences.defaultModel;
    const defaultModel = preferredModel && models.modelList.some((model) => (
      model.provider === preferredModel.provider && model.id === preferredModel.modelId
    ))
      ? preferredModel
      : models.defaultModel;
    return Response.json({ ...models, defaultModel, preferences });
  } catch {
    return Response.json({
      ...withSafeModelLoadFailure(EMPTY_MODELS),
      preferences,
    });
  }
}
