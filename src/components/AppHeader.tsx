"use client";

import { useI18n } from "@/lib/i18n/LocaleProvider";
import type { Locale } from "@/lib/i18n/messages";

export function AppHeader() {
  const { locale, setLocale, t } = useI18n();

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === "ko" || v === "en") setLocale(v as Locale);
  };

  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold tracking-tight">{t("app.title")}</h1>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("app.tagline")}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <label htmlFor="ainote-locale" className="text-xs text-zinc-500 dark:text-zinc-400">
          {t("lang.label")}
        </label>
        <select
          id="ainote-locale"
          value={locale}
          onChange={onChange}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 shadow-sm dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
        >
          <option value="ko">{t("lang.ko")}</option>
          <option value="en">{t("lang.en")}</option>
        </select>
      </div>
    </header>
  );
}
