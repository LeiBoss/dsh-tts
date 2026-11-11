/**
 * Hand-written validators. The pipeline must never write a manifest that the
 * published schema would reject, and a model-produced outline must fail loudly
 * with a JSON path (so the repair prompt can point at the exact field).
 */
/** Validation failure carrying the offending JSON pointer. */
export declare class ValidationError extends Error {
    readonly path: string;
    constructor(path: string, message: string);
}
/** Validate an outline as produced by the planning stage. */
export declare function validateOutline(value: unknown): import('./types.ts').Outline;
/** Validate a manifest before it is written to disk. */
export declare function validateManifest(value: unknown): import('./types.ts').Manifest;
//# sourceMappingURL=validate.d.ts.map