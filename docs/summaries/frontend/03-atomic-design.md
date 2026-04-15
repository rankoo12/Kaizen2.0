# Frontend Components (Atomic Design)

Kaizen organizes `packages/web/src/components` strictly around Atomic Design. Each layer merges deeper components to build complex views. Always reuse lower-level components instead of writing custom elements in a page file.

## 1. Atoms (`components/atoms`)
- The absolute base units. They contain no meaningful business logic and mostly just receive primitive props (text, icons) and pass down standard React events.
- **Examples**: `button.tsx`, `input.tsx`, `badge.tsx`, `logo.tsx`.
- **Styling**: `tailwind-merge` (`cn` utility) must be used to combine default atomic styling with custom `className` properties provided by parent components.

## 2. Molecules (`components/molecules`)
- Grouped atoms that form a cohesive UI segment, but usually still stateless.
- **Examples**: `form-field.tsx` (Label + Input + Error text), `suite-selector.tsx`, `nav-bar.tsx`.

## 3. Organisms (`components/organisms`)
- Heavy, stateful blocks of the UI. Organisms usually connect to context, hooks, or backend services.
- This is where `useCases`, `useRunPoller`, or Form Submission logical states (loading, errors) take place.
- **Examples**: `auth-card.tsx`, `new-test-panel.tsx`, `test-overview-panel.tsx`, `tests-panel.tsx`.

**Related Specs:**
- [Architecture Overview](./01-architecture-overview.md)
