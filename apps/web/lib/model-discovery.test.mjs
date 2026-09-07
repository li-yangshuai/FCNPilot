import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject(path) {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import(path);
  } catch {
    return import(path);
  }
}

const { buildModelsListUrl, parseDiscoveredModels } = await loadSubject("./model-discovery.ts");
const { resolveModelDiscoveryAuth } = await loadSubject("./model-discovery-auth.ts");
const { selectSavedModel, selectSavedProvider } = await loadSubject("./saved-model-config.ts");

test("builds protocol-appropriate model list URLs", () => {
  assert.equal(buildModelsListUrl("https://api.example.com/v1/", "openai-completions").toString(), "https://api.example.com/v1/models");
  assert.equal(buildModelsListUrl("https://api.anthropic.com", "anthropic-messages").toString(), "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(buildModelsListUrl("https://generativelanguage.googleapis.com", "google-generative-ai").toString(), "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
  assert.equal(buildModelsListUrl("https://api.example.com/custom/models", "openai-responses").toString(), "https://api.example.com/custom/models");
});

test("parses OpenAI, Anthropic, Google, and string model lists", () => {
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "gpt-5" }, { id: "claude", display_name: "Claude" }] }), [
    { id: "claude", name: "Claude" },
    { id: "gpt-5" },
  ]);
  assert.deepEqual(parseDiscoveredModels({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] }), [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ]);
  assert.deepEqual(parseDiscoveredModels(["zeta", "alpha", "alpha"]), [
    { id: "alpha" },
    { id: "zeta" },
  ]);
});

test("resolves environment-backed headers from a trusted saved provider", async () => {
  process.env.PI_WEB_DISCOVERY_TEST_TOKEN = "resolved-token";
  try {
    const auth = await resolveModelDiscoveryAuth("pi-web-header-only-test", {
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      headers: { "X-Discovery-Token": "$PI_WEB_DISCOVERY_TEST_TOKEN" },
    });
    assert.equal(auth.apiKey, undefined);
    assert.deepEqual(auth.headers, { "X-Discovery-Token": "resolved-token" });
  } finally {
    delete process.env.PI_WEB_DISCOVERY_TEST_TOKEN;
  }
});

test("selects only an unchanged persisted provider before resolving credentials", () => {
  const saved = {
    providers: {
      acme: {
        baseUrl: "https://saved.example.test/v1",
        api: "openai-completions",
        apiKey: "$PI_WEB_SAVED_TOKEN",
        headers: { "X-Saved-Token": "$PI_WEB_SAVED_HEADER" },
        models: [{ id: "saved-model", headers: { "X-Model-Token": "$PI_WEB_MODEL_HEADER" } }],
      },
    },
  };
  const submittedProvider = {
    baseUrl: "https://saved.example.test/v1",
    api: "openai-completions",
    apiKey: "$PI_WEB_SAVED_TOKEN",
    headers: { "X-Saved-Token": "$PI_WEB_SAVED_HEADER" },
  };

  assert.equal(selectSavedProvider(saved, "missing", submittedProvider).value, undefined);
  assert.equal(selectSavedProvider(saved, "acme", {
    ...submittedProvider,
    baseUrl: "http://169.254.169.254/latest/meta-data",
  }).value, undefined);
  assert.equal(selectSavedProvider(saved, "acme", {
    ...submittedProvider,
    headers: { Authorization: "$HOME" },
  }).value, undefined);

  const provider = selectSavedProvider(saved, "acme", submittedProvider).value;
  assert.equal(provider, saved.providers.acme);
  assert.equal(selectSavedModel(provider, "saved-model", {
    id: "saved-model",
    headers: { Authorization: "$HOME" },
  }).value, undefined);
  assert.equal(selectSavedModel(provider, "saved-model", {
    id: "saved-model",
    headers: { "X-Model-Token": "$PI_WEB_MODEL_HEADER" },
  }).value, saved.providers.acme.models[0]);
});
