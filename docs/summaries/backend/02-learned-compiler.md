# Learned Compiler (`src/modules/test-compiler/learned.compiler.ts`)

Converts Natural Language steps (e.g. "Click the primary login button") into a structured JSON `StepAST`.

## Three-Level Lookup Strategy
The platform aims for **Zero Hardcoding** linguistic mapping by using LLMs but bypassing latency through heavily pre-seeded caches.
- **L1 (In-Memory Map)**: Fastest lookup within the node process.
- **L2 (PostgreSQL `compiled_ast_cache`)**: Persisted patterns. The DB is seeded with a baseline SQL file mapping standard verbs (`click`, `type`, `assert_visible`).
- **L3 (LLM Fallback)**: If it's a completely novel phrasing, the LLM processes it and automatically writes the newly learned pattern back to L1 and L2 for future O(1) latency runs.

## `StepAST` Structure
The result always maps to an AST interface specifying:
- `action`: `click`, `type`, `select`, `wait`, `navigate`, etc.
- `targetDescription`: A normalized description of *where* the action occurs.
- `value`: Data input (like typing "test@email.com").
