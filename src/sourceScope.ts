import { CortexClientError } from "./types.js";

export const SOURCE_CODES = [
  "hiqlcd", "hiqlcd-al", "calcd", "hiq-cesi", "ecoinvent", "carbonminds",
  "agrifootprint", "ef", "auslci", "bafu", "bioenergiedat", "elcd", "needs",
  "ozlci", "recycledplastics", "usda", "uslci", "worldsteel",
] as const;

const EPD_TOOLS = new Set(["epd_search", "epd_peer_benchmark"]);
const LOCAL_COMMANDS = new Set(["doctor", "login", "logout", "version", "list", "describe", "call"]);
const DATA_COMMANDS = new Set(["sources", "search", "search-datasets", "search-flows", "verify-datasets", "verify-flows"]);

/** A CLI invocation boundary, not an authorization grant or an OS sandbox. */
export class SourceScope {
  constructor(readonly code: string) {
    if (code !== "epd" && !SOURCE_CODES.includes(code as typeof SOURCE_CODES[number])) {
      throw new CortexClientError("validation", `Unknown source scope: ${code}`);
    }
  }

  command(command: string | undefined): void {
    if (!command || LOCAL_COMMANDS.has(command)) return;
    if (this.code !== "epd" && DATA_COMMANDS.has(command)) return;
    if (this.code === "epd" && EPD_TOOLS.has(command.replaceAll("-", "_"))) return;
    throw new CortexClientError("validation", `${command} is not available in source scope ${this.code}`);
  }

  source(value: string): string {
    if (this.code === "epd" || value.toLowerCase() !== this.code) {
      throw new CortexClientError("validation", `Source ${value} conflicts with scope ${this.code}`);
    }
    return this.code;
  }

  sources(value?: string): string {
    for (const source of value?.split(",") ?? []) this.source(source.trim());
    return this.source(this.code);
  }

  supportsTool(name: string): boolean {
    return this.code === "epd" && EPD_TOOLS.has(name);
  }

  tool(name: string): void {
    if (this.supportsTool(name)) return;
    // Opaque dataset keys carry no verifiable input source. Do not guess their encoding,
    // or retrieve another source first and hide it after the fact.
    throw new CortexClientError("validation", `${name} has no supported source-scoped contract for ${this.code}; use an explicitly selected aggregate plugin for cross-source tools`);
  }

  result(value: unknown, semantic = false): void {
    if (this.code === "epd") return;
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const source = record.source as { code?: unknown } | undefined;
      const actual = source && typeof source === "object" ? source.code : record.src;
      if (actual !== undefined && (typeof actual !== "string" || actual.toLowerCase() !== this.code)) {
        throw new CortexClientError("upstream", `Response source conflicts with scope ${this.code}`);
      }
      Object.values(record).forEach(visit);
    };
    if (!semantic) {
      const results = Array.isArray(value) ? value : [value];
      if (results.some(result => typeof (result as { source?: { code?: unknown } })?.source?.code !== "string")) {
        throw new CortexClientError("upstream", "Response has no verifiable source coordinate");
      }
    }
    if (semantic) {
      const datasets = (value as { datasets?: { src?: unknown }[] })?.datasets;
      if (datasets?.some(dataset => typeof dataset.src !== "string")) {
        throw new CortexClientError("upstream", "Search returned a dataset without a verifiable source");
      }
    }
    visit(value);
  }
}

export function scopedInvocation(argv: string[]): { argv: string[]; scope?: SourceScope } {
  if (argv[0] !== "scoped") return { argv };
  const scope = new SourceScope(argv[1] ?? "");
  const rest = argv.slice(2);
  scope.command(rest.find(arg => !arg.startsWith("-")));
  return { argv: rest, scope };
}
