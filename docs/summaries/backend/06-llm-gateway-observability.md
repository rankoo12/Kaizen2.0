# LLM Gateway & Observability

## LLM Gateway (`src/modules/llm-gateway`)
- A centralized abstraction layer masking raw calls to OpenAI and Anthropic SDKs (`openai.gateway.ts`, etc.).
- Exposes clean interfaces (`ILLMGateway`) so the system can hot-swap models.
- Integrates with the **Billing Meter** (`PostgresBillingMeter`) to track token usage per tenant strictly before responding.

## Observability (`src/modules/observability`)
- Uses `pino` (`pino.observability.ts`) for JSON-structured, level-based logging.
- Includes OpenTelemetry traces/spans internally to track execution time of complex operations (like the AI resolution process or test compilation).
- Observability instances are injected into nearly all classes via standard constructor Dependency Injection.

**Related Specs:**
- [Healing Engine (Relies on LLM)](./04-healing-engine.md)
- [Learned Compiler (Relies on LLM)](./02-learned-compiler.md)
