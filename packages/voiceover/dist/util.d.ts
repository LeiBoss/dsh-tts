/** Full sha256 hex digest, prefixed so manifests are self-describing. */
export declare function sha256(input: string | Uint8Array): string;
/** Prefixed digest used in manifests (`sha256:<64 hex>`). */
export declare function sha256Tag(input: string | Uint8Array): string;
/** Short, filesystem-safe identity for project directories. */
export declare function shortId(input: string): string;
/** Read JSON, treating a missing or malformed file as absent. */
export declare function readJson<T>(path: string): Promise<T | undefined>;
/** Write JSON via a temp sibling and rename, so readers never see a partial file. */
export declare function writeJsonAtomic(path: string, value: unknown): Promise<void>;
/**
 * Split normalized prose into paragraphs on blank lines, dropping empty ones.
 * Paragraph indices are the currency of `sourceRange`, so this must be stable.
 */
export declare function splitParagraphs(text: string): string[];
//# sourceMappingURL=util.d.ts.map