import { OFFLINE_LANGUAGE_NAMES } from "@/lib/offline-language-bootstrap";

/** Display name: server catalog map → offline bootstrap → ISO code. */
export function resolveLangName(
  code: string,
  languageNames?: Record<string, string> | null,
): string {
  const c = (code || "").trim().toLowerCase();
  if (!c) return "";
  return languageNames?.[c] ?? OFFLINE_LANGUAGE_NAMES[c] ?? c;
}
