/** Report the page hostname for server-side usage_events.site_host. */
export function currentSiteHost(): string | null {
  try {
    const h = location.hostname?.trim().toLowerCase().replace(/^www\./, "");
    if (!h || h.length > 128) return null;
    return h;
  } catch {
    return null;
  }
}
