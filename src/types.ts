/** Error raised by the client (config / transport / validation) or relayed from the server. */
export class CortexClientError extends Error {
  constructor(
    public readonly kind: "config" | "validation" | "transport" | "upstream",
    message: string,
    /** Server-supplied error code, when kind === "upstream". */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "CortexClientError";
  }
}

/** Exit codes — agents branch on these, so they are part of the contract. */
export const EXIT = {
  ok: 0,
  unknown: 1,
  config: 2,
  validation: 3,
  upstream: 4,
  transport: 5,
} as const;

export function exitCodeFor(err: unknown): number {
  if (err instanceof CortexClientError) {
    switch (err.kind) {
      case "config": return EXIT.config;
      case "validation": return EXIT.validation;
      case "upstream": return EXIT.upstream;
      case "transport": return EXIT.transport;
    }
  }
  return EXIT.unknown;
}
