/**
 * Human-readable rendering for the tools whose payload shape is stable and
 * whose output a person actually reads.
 *
 * Why not render everything: subcommands are generated from the server catalog,
 * so most payloads are whatever the server decides — printing them raw is
 * honest. But `lookup_datasets` is *the* place a number gets handed to a human,
 * and a number without its basis and link is not usable. Rendering it here also
 * keeps the opaque `key` off the screen: it is for the next tool call, never
 * for the reader.
 *
 * When the shape doesn't match, fall back to raw JSON rather than guessing.
 */

interface LookupHit {
  key?: string;
  name?: string;
  unit?: string;
  loc?: string;
  model?: string;
  src?: string;
  ver?: string;
  ref_product?: string;
  link?: string;
  gwp?: number;
  gwp100?: number;
  gwp_unit?: string;
  restricted?: boolean;
  restriction?: { purchase_url?: string } | null;
  [k: string]: unknown;
}

export function formatLookup(raw: string): string | undefined {
  let j: { data?: { hits?: LookupHit[] }; explanations?: string[] };
  try {
    j = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const hits = j?.data?.hits;
  if (!Array.isArray(hits) || !hits.length) return undefined;

  const out: string[] = [];
  let purchase = "";
  for (const h of hits) {
    const basis = [h.src, h.ver, h.model, h.loc].filter(Boolean).join(" · ");
    const gwp = h.gwp ?? h.gwp100;
    const value = h.restricted
      ? "数值受限(该库需数据包权益)"
      : gwp !== undefined
        ? `${gwp} ${h.gwp_unit ?? "kg CO2e"}`
        : "无 headline GWP";
    if (h.restricted && h.restriction?.purchase_url) purchase = h.restriction.purchase_url;
    out.push(
      `▸ ${h.name ?? "(无名)"}`,
      `  参考流: ${h.ref_product ?? "-"}${h.unit ? `   单位: ${h.unit}` : ""}`,
      `  基准:   ${basis || "-"}`,
      `  GWP:    ${value}`,
      `  链接:   ${h.link ?? "-"}`,
      "",
    );
  }
  for (const e of j.explanations ?? []) out.push(e);
  if (purchase) out.push(`开通商业库数据包: ${purchase}`);
  return out.join("\n").trimEnd();
}

/** Tool name → renderer. Anything not here prints the server payload as-is. */
export const RENDERERS: Record<string, (raw: string) => string | undefined> = {
  lookup_datasets: formatLookup,
};
