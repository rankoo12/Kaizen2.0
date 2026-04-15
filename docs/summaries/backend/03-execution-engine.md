# Execution Engine (`src/modules/execution-engine`)

Executes compiled `StepAST` definitions using **Playwright**.

## Process Flow
1. Receives an AST action (`executeStep`).
2. Receives a `SelectorSet` containing a list of potential CSS/XPath selectors generated primarily by the component resolution engine (`LLMElementResolver`, etc).
3. Executes Playwright primitives (`page.click()`, `page.fill()`, `page.goto()`).

## Safety Fallbacks
- Iterates over multiple selectors in the `SelectorSet` if the first attempt fails or is not found.
- Differentiates strictly between checkboxes/radios (`page.check()`) and normal entities, dynamically reading DOM roles to avoid Playwright exceptions when calling `click()` on non-clickable components.
- On total failure, captures the precise Playwright Error to pass down to the **Healing Engine**.
