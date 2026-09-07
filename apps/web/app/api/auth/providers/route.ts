import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { getCurrentAccountUid } from "@/lib/accounts";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
export async function GET() {
  if (!await getCurrentAccountUid()) return Response.json({ error: "Not logged in" }, { status: 401 });
  const modelRuntime = await ModelRuntime.create();
  const providers = buildOAuthProviderList(await collectProviderListingInputs(modelRuntime));
  return Response.json({ providers });
}
