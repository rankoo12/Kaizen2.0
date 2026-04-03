Kaizen — Global Brain Seeding Specification

Associated with Kaizen Master Spec v3.0

1. Purpose

To solve the "Cold Start" problem for Kaizen SaaS platform. When a new tenant executes their first test run, Kaizen must deliver a high probability of cache hits against standard web components. This ensures low execution latency, zero LLM cost, and an immediate "wow" factor during onboarding. This specification defines the automated and manual pipelines required to pre-populate the selector_cache table with element_embedding and step_embedding vectors inside the shared global namespace.

2. Approach A: "Dogfooding" via Internal Projects (High Fidelity)

Synthetic data is useful, but mapping out real-world, complex, and nested application structures provides the highest quality semantic embeddings. Internal projects will act as the primary testing ground. Because the core development team understands the underlying source code of these targets, the LLM's initial resolutions can be strictly audited for accuracy before the vectors are committed to the shared pool.

Execution Targets:

E-Commerce Flows: Writing end-to-end checkout, cart manipulation, and inventory filtering tests against the Brunch clothing brand storefront. This captures embeddings for standard Shopify/custom e-commerce DOM patterns, payment gateways, and product grids.

Data-Heavy Dashboards: Developing test suites for the MapleStory market database application. This secures semantic vectors for complex data tables, pagination, sorting filters, and dynamic search bars.

Internal Tools & Forms: Automating interactions within the multi-store scheduling application (outlet and חנות הדגל). This captures localized inputs, calendar pickers, cross-origin authentication flows, and dynamic grid layouts.

Pipeline:

Tests are written and executed locally.

The LLMElementResolver performs initial element mapping.

Developers audit the CandidateNode selected and the resulting element_embedding.

Approved mappings are explicitly pushed to the selector_cache with is_shared: true and tenant_id: NULL.

3. Approach B: Component Library Crawling (Synthetic Generation)

To understand the internet's most common building blocks, Kaizen will ingest the documentation pages of the top open-source UI libraries.

Target Libraries:

Material UI (MUI)

Tailwind UI

Ant Design

Bootstrap

Execution Flow:

A background Node.js job navigates to the target documentation URLs via Playwright.

The IDOMPruner extracts the active AX Tree for the components on the page.

The job sends the structured AX Tree to the ILLMGateway using a strict data-generation prompt.

The LLM Prompt (Data Generation): System: You are an expert QA automation engineer. Your goal is to generate natural language test steps for the interactive elements in the provided Accessibility Tree (AX Tree).

User: Here is the AX Tree for a UI component documentation page. {AX_TREE_JSON}

For every actionable element (e.g., button, textbox, combobox, tab), generate a plain English instruction a human user would logically write to interact with it.

Return ONLY a valid JSON array of objects strictly matching this schema: [ { "rawText": "The plain English command (e.g., 'Click the primary submit button')", "targetDescription": "A concise description of the element's visual intent", "action": "click|type|select", "cssSelector": "The best CSS selector from the provided AX node data" } ]

For each generated object, the system calls the embedding API (text-embedding-3-small) to create the step_embedding (from rawText) and the element_embedding (from the AX node data).

Data is bulk-inserted into PostgreSQL via pgvector.

4. Approach C: The Top 50 SaaS Crawler (Real-World Patterns)

A scheduled Playwright script will target publicly accessible, unauthenticated pages (login, signup, forgot password, pricing) of the top 50 SaaS platforms (e.g., GitHub, Jira, Salesforce, Slack, Shopify admin).

Execution Flow:

The crawler script navigates to the target (e.g., github.com/login).

The script issues standard predefined Kaizen steps to the API (e.g., "Type user@test.com into the username field", "Click sign in").

The standard Kaizen v3 architecture handles the LLM resolution.

A post-execution hook verifies the DOM interaction did not result in an error.

Upon verification, the embeddings are cached into the shared namespace.

5. Maintenance & Vector Decay in the Shared Pool

Because the shared pool is heavily relied upon, stale vectors are highly detrimental.

Automated Pruning: A weekly chron job will select 5% of the shared pool at random and execute a headless verification run against the cached domain.

Heal-Driven Updates: If a tenant relies on a shared vector, and the step fails but is successfully healed via ElementSimilarityStrategy or ResolveAndRetryStrategy, the updated element_embedding replaces the old one in the shared pool globally.

Anomaly Detection: If a shared vector triggers failures across multiple distinct tenants within a 24-hour period, its confidence_score is immediately zeroed, forcing a fresh LLM resolution.
