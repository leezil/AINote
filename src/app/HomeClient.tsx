"use client";

import dynamic from "next/dynamic";

const WorkspaceApp = dynamic(
  () =>
    import("@/components/workspace/WorkspaceApp").then((m) => m.WorkspaceApp),
  { ssr: false, loading: () => <p className="p-6 text-sm text-zinc-500">로딩…</p> },
);

export function HomeClient() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkspaceApp />
    </div>
  );
}
