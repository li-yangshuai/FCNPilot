import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { invalidateModelsCache } from "@/lib/models-cache";
import { removeStoredCredentialIfType } from "@/lib/provider-credential-store";
import { getCurrentAccountUid } from "@/lib/accounts";
import { markModelConfigChanged } from "@/lib/model-config-revision";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  if (!await getCurrentAccountUid()) return Response.json({ error: "Not logged in" }, { status: 401 });
  const { provider } = await params;
  const modelRuntime = await ModelRuntime.create();
  if (!modelRuntime.getProvider(provider)?.auth.oauth) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }
  const removal = await removeStoredCredentialIfType(provider, "oauth");
  if (removal.status === "type_mismatch") {
    return Response.json({ error: `${provider} is authenticated with an API key, not OAuth` }, { status: 409 });
  }
  invalidateModelsCache();
  if (removal.status === "removed") markModelConfigChanged();
  return Response.json({ ok: true });
}
