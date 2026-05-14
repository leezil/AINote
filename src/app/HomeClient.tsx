"use client";

import dynamic from "next/dynamic";
import { useI18n } from "@/lib/i18n/LocaleProvider";

function WorkspaceLoading() {
  const { t } = useI18n();
  return <p className="p-6 text-sm text-zinc-500">{t("home.loading")}</p>;
}

const WorkspaceApp = dynamic(
  () =>
    import("@/components/workspace/WorkspaceApp").then((m) => m.WorkspaceApp),
  { ssr: false, loading: WorkspaceLoading },
);

export function HomeClient() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkspaceApp />
    </div>
  );
}
