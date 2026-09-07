import { Suspense } from "react";
import { ClientApp } from "@/components/ClientApp";
import { I18nProvider } from "@/hooks/useI18n";
import { readIfcnWorkspaceConfiguration } from "@/lib/ifcn-workspace";

export const dynamic = "force-dynamic";

export default function Home() {
  const workspace = readIfcnWorkspaceConfiguration();
  const defaultCwd = workspace.valid ? workspace.cwd : null;
  return (
    <Suspense>
      <I18nProvider>
        <ClientApp defaultCwd={defaultCwd} />
      </I18nProvider>
    </Suspense>
  );
}
