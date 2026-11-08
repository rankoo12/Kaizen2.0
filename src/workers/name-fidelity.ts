/**
 * Relocated to src/modules/element-resolver/name-fidelity.ts (2026-11-08,
 * finding #16): the healing engine needs the same name gates the worker uses,
 * and modules must not import from workers. This shim keeps every existing
 * worker-side import working; new code imports from the module path.
 */
export { quotedName, nameOverlaps, nameAbsent, salientWords, countDriftMatch } from '../modules/element-resolver/name-fidelity';
