/**
 * Base-URL hygiene shared by the custom-provider create dialog and the
 * provider detail editor. Users habitually paste the full operation endpoint
 * they copied from a vendor's curl example ("…/v1/chat/completions"); saving
 * that verbatim makes model discovery probe "…/chat/completions/models" and
 * fail with a confusing 404. The editor normalizes such inputs down to the
 * service root before they reach settings.json.
 *
 * Validation and normalization are separate: a URL can be rejectable
 * (credentials inline, query, fragment) yet still need the precise complaint,
 * and a valid URL can still need trimming. Both are pure — no i18n, no Vue.
 */

/** Operation-path suffixes we strip, most specific wins by iteration order. */
const OPERATION_SUFFIXES = ["/chat/completions", "/responses", "/messages", "/models"] as const;

export type BaseUrlIssueKind = "scheme" | "userinfo" | "query" | "hash";

/**
 * The first reason the input is not a storable service root, or null when the
 * value is acceptable. Empty input is null here: "required" is the caller's
 * policy (catalog providers legitimately leave it to the default), not this
 * module's.
 */
export function getBaseUrlIssue(raw: string): BaseUrlIssueKind | null {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "scheme";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
  if (url.username || url.password) return "userinfo";
  if (url.search) return "query";
  if (url.hash) return "hash";
  return null;
}

/**
 * Trim trailing slashes and peel known operation suffixes until only the
 * service root is left ("https://host/v1/chat/completions" →
 * "https://host/v1"). Peeling never destroys the host: a value whose remain
 * would stop being an absolute URL is kept as-is. Case-insensitive on the
 * suffix (vendors spell it "/v1/Chat/Completions" in the wild), verbatim
 * everywhere else.
 */
export function normalizeBaseUrlInput(raw: string): string {
  let value = raw.trim().replace(/\/+$/, "");
  if (!value) return value;
  for (;;) {
    const lower = value.toLowerCase();
    const suffix = OPERATION_SUFFIXES.find((candidate) => lower.endsWith(candidate));
    if (!suffix) return value;
    const candidate = value.slice(0, value.length - suffix.length).replace(/\/+$/, "");
    try {
      if (!new URL(candidate).host) return value;
    } catch {
      return value;
    }
    value = candidate;
  }
}
