import { NextResponse } from "next/server";
import { resolveModelDiscoveryAuth } from "@/lib/model-discovery-auth";
import { buildModelsListUrl, parseDiscoveredModels } from "@/lib/model-discovery";
import { readModelsConfig } from "@/lib/models-config-store";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { selectSavedProvider } from "@/lib/saved-model-config";
import { getCurrentAccountUid } from "@/lib/accounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DISCOVERY_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHeader(headers: Headers, name: string): boolean {
  return headers.has(name);
}

function buildHeaders(api: string, apiKey: string | undefined, configured: Record<string, string>): Headers {
  const headers = new Headers(configured);
  if (!hasHeader(headers, "accept")) headers.set("Accept", "application/json");
  if (!apiKey) return headers;

  if (api === "anthropic-messages") {
    if (!hasHeader(headers, "x-api-key")) headers.set("x-api-key", apiKey);
    if (!hasHeader(headers, "anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else if (api === "google-generative-ai") {
    if (!hasHeader(headers, "x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
  } else if (!hasHeader(headers, "authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }

  try {
    if (!await getCurrentAccountUid()) {
      return NextResponse.json({ error: "Not logged in" }, { status: 401 });
    }

    let parsedBody: unknown;
    try {
      parsedBody = await req.json();
    } catch {
      return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
    }
    if (!isRecord(parsedBody)) {
      return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    }
    const body = parsedBody;
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ error: "providerName is required" }, { status: 400 });
    if (providerName.length > 200) return NextResponse.json({ error: "providerName is too long" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ error: "provider is required" }, { status: 400 });

    const selected = selectSavedProvider(readModelsConfig(), providerName, body.provider);
    if (!selected.value) {
      return NextResponse.json({ error: selected.error }, { status: 409 });
    }
    const provider = selected.value;

    const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
    if (!baseUrl) return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    const api = typeof provider.api === "string" && provider.api
      ? provider.api
      : "openai-completions";

    let endpoint: URL;
    try {
      endpoint = buildModelsListUrl(baseUrl, api);
    } catch {
      return NextResponse.json({ error: "Base URL is invalid" }, { status: 400 });
    }

    const auth = await resolveModelDiscoveryAuth(providerName, provider);
    if (typeof provider.apiKey === "string" && provider.apiKey.trim() && !auth.apiKey) {
      return NextResponse.json({ error: `No API key found for "${providerName}"` }, { status: 400 });
    }

    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: buildHeaders(api, auth.apiKey, auth.headers),
      redirect: "error",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    const responseText = await response.text();
    if (!response.ok) {
      return NextResponse.json({
        error: responseText.slice(0, 500) || `Upstream returned HTTP ${response.status}`,
        status: response.status,
      }, { status: 502 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      return NextResponse.json({ error: "Upstream model list was not valid JSON" }, { status: 502 });
    }
    const models = parseDiscoveredModels(payload);
    if (models.length === 0) {
      return NextResponse.json({ error: "No models found in the upstream response" }, { status: 502 });
    }

    return NextResponse.json({ models, endpoint: endpoint.toString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof DOMException && error.name === "TimeoutError" ? 504 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
