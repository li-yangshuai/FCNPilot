import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";

const tempRoot = mkdtempSync(join(tmpdir(), "pi-web-model-route-security-"));
const agentDir = join(tempRoot, "agent");
mkdirSync(agentDir, { recursive: true });

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousApiKey = process.env.PI_WEB_MODEL_ROUTE_API_KEY;
const previousHeader = process.env.PI_WEB_MODEL_ROUTE_HEADER;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_MODEL_ROUTE_API_KEY = "server-api-key";
process.env.PI_WEB_MODEL_ROUTE_HEADER = "server-header-secret";

const savedProvider = {
  baseUrl: "https://saved-provider.example.test/v1",
  api: "openai-completions",
  apiKey: "$PI_WEB_MODEL_ROUTE_API_KEY",
  headers: { "X-Saved-Header": "$PI_WEB_MODEL_ROUTE_HEADER" },
  models: [{ id: "saved-model", name: "Saved model" }],
};
writeFileSync(join(agentDir, "models.json"), JSON.stringify({
  providers: { "saved-provider": savedProvider },
}));

const submittedProvider = Object.fromEntries(
  Object.entries(savedProvider).filter(([key]) => key !== "models"),
);
const submittedModel = savedProvider.models[0];

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST: discoverModels } = await jiti.import("./discover/route.ts");
const { POST: testModel } = await jiti.import("./test/route.ts");

test.after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousApiKey === undefined) delete process.env.PI_WEB_MODEL_ROUTE_API_KEY;
  else process.env.PI_WEB_MODEL_ROUTE_API_KEY = previousApiKey;
  if (previousHeader === undefined) delete process.env.PI_WEB_MODEL_ROUTE_HEADER;
  else process.env.PI_WEB_MODEL_ROUTE_HEADER = previousHeader;
});

function jsonRequest(path, body, headers = {}) {
  return new Request(`http://localhost:30141${path}`, {
    method: "POST",
    headers: {
      host: "localhost:30141",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("model outbound routes enforce request and JSON boundaries", async () => {
  for (const [path, handler] of [
    ["/api/models-config/discover", discoverModels],
    ["/api/models-config/test", testModel],
  ]) {
    const crossSite = await handler(jsonRequest(path, {}, {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }));
    assert.equal(crossSite.status, 403);

    const wrongContentType = await handler(new Request(`http://localhost:30141${path}`, {
      method: "POST",
      headers: { host: "localhost:30141", "content-type": "text/plain" },
      body: "{}",
    }));
    assert.equal(wrongContentType.status, 415);

    const malformed = await handler(jsonRequest(path, "{"));
    assert.equal(malformed.status, 400);

    const arrayBody = await handler(jsonRequest(path, []));
    assert.equal(arrayBody.status, 400);
  }
});

test("both outbound routes authenticate before parsing client JSON", () => {
  for (const relativePath of ["./discover/route.ts", "./test/route.ts"]) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    const accountCheck = source.indexOf("getCurrentAccountUid()");
    const bodyParse = source.indexOf("await req.json()");
    assert.ok(accountCheck >= 0, `${relativePath} is missing its account check`);
    assert.ok(bodyParse > accountCheck, `${relativePath} parses JSON before authentication`);
  }
});

test("discovery rejects arbitrary URLs and env-backed headers before fetch", async (t) => {
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not be called for an unsaved provider draft");
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const metadataUrl = await discoverModels(jsonRequest("/api/models-config/discover", {
    providerName: "saved-provider",
    provider: {
      ...submittedProvider,
      baseUrl: "http://169.254.169.254/latest/meta-data",
    },
  }));
  assert.equal(metadataUrl.status, 409);

  const envHeader = await discoverModels(jsonRequest("/api/models-config/discover", {
    providerName: "saved-provider",
    provider: {
      ...submittedProvider,
      headers: { Authorization: "$HOME" },
    },
  }));
  assert.equal(envHeader.status, 409);
  assert.equal(fetchCalls, 0);
});

test("discovery resolves credentials only for the unchanged saved endpoint", async (t) => {
  const previousFetch = globalThis.fetch;
  let requestedUrl;
  let requestedHeaders;
  let redirect;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedHeaders = new Headers(init?.headers);
    redirect = init?.redirect;
    return new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const response = await discoverModels(jsonRequest("/api/models-config/discover", {
    providerName: "saved-provider",
    provider: submittedProvider,
  }));
  assert.equal(response.status, 200);
  assert.equal(requestedUrl, "https://saved-provider.example.test/v1/models");
  assert.equal(requestedHeaders.get("authorization"), "Bearer server-api-key");
  assert.equal(requestedHeaders.get("x-saved-header"), "server-header-secret");
  assert.equal(redirect, "error");
  assert.deepEqual(await response.json(), {
    models: [{ id: "discovered-model" }],
    endpoint: "https://saved-provider.example.test/v1/models",
  });
});

test("model tests reject unsaved provider and model fields before creating a runtime", async () => {
  const providerResponse = await testModel(jsonRequest("/api/models-config/test", {
    providerName: "saved-provider",
    provider: { ...submittedProvider, baseUrl: "http://127.0.0.1:9/v1" },
    model: submittedModel,
  }));
  assert.equal(providerResponse.status, 409);

  const modelResponse = await testModel(jsonRequest("/api/models-config/test", {
    providerName: "saved-provider",
    provider: submittedProvider,
    model: { ...submittedModel, headers: { Authorization: "$HOME" } },
  }));
  assert.equal(modelResponse.status, 409);
});

test("model tests retain the exact saved provider and model flow", async (t) => {
  let receivedPath;
  let receivedAuthorization;
  let receivedSavedHeader;
  const server = createServer((request, response) => {
    receivedPath = request.url;
    receivedAuthorization = request.headers.authorization;
    receivedSavedHeader = request.headers["x-saved-header"];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "saved-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "saved-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const localProvider = {
    ...savedProvider,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { "saved-provider": localProvider },
  }));
  t.after(() => writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { "saved-provider": savedProvider },
  })));

  const localSubmittedProvider = Object.fromEntries(
    Object.entries(localProvider).filter(([key]) => key !== "models"),
  );
  const response = await testModel(jsonRequest("/api/models-config/test", {
    providerName: "saved-provider",
    provider: localSubmittedProvider,
    model: submittedModel,
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true, payload.error);
  assert.equal(payload.status, 200);
  assert.equal(payload.responseText, "OK");
  assert.equal(receivedPath, "/v1/chat/completions");
  assert.equal(receivedAuthorization, "Bearer server-api-key");
  assert.equal(receivedSavedHeader, "server-header-secret");
});
