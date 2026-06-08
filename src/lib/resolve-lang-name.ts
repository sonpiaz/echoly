import { OFFLINE_LANGUAGE_NAMES } from "@/lib/offline-language-bootstrap";

/** Display name: server catalog map → offline bootstrap → ISO code.
 *  The special sentinel `"auto"` resolves to `"Auto-detect"`. */
export function resolveLangName(
  code: string,
  languageNames?: Record<string, string> | null,
): string {
  const c = (code || "").trim().toLowerCase();
  if (!c) return "";
  if (c === "auto") return "Auto-detect";
  return languageNames?.[c] ?? OFFLINE_LANGUAGE_NAMES[c] ?? c;
}
