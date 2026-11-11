/**
 * Public vocabulary shared by the pipeline, the artifact writer, and the tools.
 * Everything here is plain data: no cordis, no DSH imports, so the core can be
 * unit-tested without a host.
 */
/** Prompt version must change whenever a prompt changes (see PROMPTS.md). */
export const PROMPT_VERSION = 'p1.3';
/** Bump when `manifest.json`'s shape changes. */
export const SCHEMA_VERSION = 1;
//# sourceMappingURL=types.js.map