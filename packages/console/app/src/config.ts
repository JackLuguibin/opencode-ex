/** Site and documentation origins belong to the ex deployment. */
export const config = {
  baseUrl: import.meta.env.VITE_OPENCODE_EX_SITE_URL ?? "http://localhost:3001",
  v1DocsUrl:
    import.meta.env.VITE_OPENCODE_EX_V1_DOCS_URL ?? (import.meta.env.DEV ? "http://127.0.0.1:4321" : undefined),
  v2DocsUrl:
    import.meta.env.VITE_OPENCODE_EX_V2_DOCS_URL ?? (import.meta.env.DEV ? "http://127.0.0.1:3000" : undefined),
} as const
