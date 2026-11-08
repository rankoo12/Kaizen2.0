# Kaizen research: 2026 backfill (Jan 1 – Nov 8 2026)

> This is the foundation report for the daily runs. It skips everything already in [2026-11-08.md](2026-11-08.md), only pointing to it where relevant: the gpt-4o retirement, Playwright 1.65, the Decisions API, Haiku 5.5, Node 20 end-of-life, BullMQ 6 and agent-memory lessons.
>
> **How this was made:** 8 parallel research agents (models, harnessing, browser libs, anti-bot, arXiv, competitors, ecosystem/security, pricing), each covering the full window. Findings were then checked against the repo on 2026-11-08.
>
> **Versions read from the repo:**
> - `fastify` 4.29.1
> - `next` 15.5.15
> - `react` 19.2.4 (web)
> - `openai` 4.104.0
> - `bullmq` 5.71.1
> - `playwright` 1.58.2
> - `pgvector/pgvector:pg16` (floating tag)
> - `redis:7-alpine`
> - `nginx:alpine`
>
> **Source quality:** sources marked (2°) are secondary, so verify them before acting on anything high-stakes.

---

## 0. Top 10 things to do for Kaizen

| # | Action | Why | Effort | Section |
|---|---|---|---|---|
| 1 | **Patch the web app: `next` 15.5.15 → 15.5.29+ (React to a patched 19.2.x). Then plan Next 16.** | 15.5.15 is exposed to the July security release (15.5.21: middleware auth bypass, SSRF, Server Actions DoS) and to the Sep–Nov fixes. Next 15 lost support on Oct 21. `middleware.ts` gates `/tests` on cookie presence only. | Patch: hours. Next 16: 2–3 days | [3.1](#31-web--api-security-next-15--fastify-4) |
| 2 | **Upgrade Fastify 4.29.1 → 5.12.2+** | v4 has been out of support since Jun 2025. No v4 fix exists for CVE-2026-25223 (Content-Type tab trick skips schema validation, CVSS 7.5) or CVE-2026-76169 (malformed URL skips not-found-handler auth). | 1–2 days | [3.1](#31-web--api-security-next-15--fastify-4) |
| 3 | **Do one "LLM gateway modernization" PR: Node 24 → `openai` v7 (needs Node 22+) → `gpt-6-luna` with `reasoning_effort:"none"` → cache-aware prompt layout → Flex for background jobs** | Luna defaults to `medium` reasoning, so latency and cost go up. Since Oct 20, cache writes are billed (1.25×). Flex runs at half price for the test-writer and Explorer. OpenAI fine-tuning is winding down, so there is no fine-tuning path. | 3–4 days, including the bench | [3.2](#32-llm-gateway-modernization) |
| 4 | **Harden the npm supply chain** | 2026 saw three worm waves (TanStack in May, node-gyp in Jun, ChainDrop in Aug), some with *valid provenance*. Lockfile checked: not affected (flat-cache 4.0.1, file-entry-cache 8.0.0, keyv 4.5.4). | ½ day | [3.3](#33-supply-chain--data-tier-images) |
| 5 | **Re-pull and pin the data-tier images:** PG ≥16.15, Redis ≥7.4.9, nginx ≥1.30.2 | CVE-2026-14666: cached RLS policies aren't re-checked after a role change. This matters before the planned switch to an unprivileged runtime role (migrations 036/037). Also 5 Redis CVEs (May) and an nginx rewrite heap overflow. | ½ day | [3.3](#33-supply-chain--data-tier-images) |
| 6 | **Govern shared-pool writes (fixes issue 8):** N-tenant confirmation, provenance, scope filter inside the vector query, expected-state check on cache hits, replay-verified promotion | Two June papers found memory poisoning succeeds ~50% of the time, and that scope checks applied after semantic search leak (43.9%). Defending the write path works; filtering content doesn't. | ~1 week | [3.4](#34-shared-pool-write-path-governance-issue-8) |
| 7 | **Rebuild RECON as a state-graph explorer** (find clickable elements via `cursor:pointer`/`tabindex`, hook `pushState`, use aria-hash as state identity, fill forms with an LLM behind a danger guard) | Fixes the known "SPA button navigation" gap and the "never submits forms" depth ceiling. SpiderSapien attributes 74% of its coverage gain to these two parts. | 1–2 weeks | [3.5](#35-recon-state-graph-explorer) |
| 8 | **Add deterministic quality gates to the test-writer before the LLM judge:** oracle-strength taxonomy, a guard that blocks heals from weakening assertions, "no evidence = Inconclusive", cross-step symbolic oracles, and judge validation with kappa | 80% of agent-written tests have weak oracles. Repair agents "converge" by deleting assertions. All agents score <30% F1 on WebTestBench. Kaizen sells trust, and this is where trust is won. | 3–5 days | [3.6](#36-test-writer-quality-gates) |
| 9 | **Ship pricing and plan limits:** rate card where rule-based heals are free and LLM heals are ~$0.25, hard caps, projected bill, plus a permanent Playwright export ("escrow") | Momentic charges $1.25 per heal. QA Wolf now has a self-serve tier at 15¢ per runner-minute. Octomind, Bugster and DogQ shut down and their exports died with them. Plan limits are known issue 3. | 1–2 weeks | [3.7](#37-pricing-plan-limits--export-escrow) |
| 10 | **Bot-protection kit:** per-project bypass header + Cloudflare rule template, challenge detection from response headers, then Web Bot Auth signing + Cloudflare BotBase | QA.tech already documents this (table stakes). Cloudflare, Akamai and DataDome all verify Web Bot Auth. Cloudflare's Oct trust bands score robots.txt and 429 behaviour. | Kit: days. Signing: 1–2 weeks | [3.8](#38-bot-protection-onboarding--signed-agent) |

**Biggest strategic threat:** Momentic shipped much of Kaizen's roadmap first, starting in June: failure classification, intent-aware auto-update, a context-aware Explore Agent, and "Mo" with a public QA-Bench (19.3% recall, 84% precision). Checksum shipped the same triage loop in August. Kaizen's answer should be **proven-falsifiable findings** (oracle audit + vacuity probe), backed by published trust metrics. See [2-F](#f-competitors--market).

---

## 1. TL;DR
- **Security debt is the most urgent item.** The API runs Fastify 4 (end-of-life, with unpatched 7.5 CVEs), the web app runs Next 15.5.15 (end-of-life, several High CVEs, auth in middleware), and the runtime is Node 20 (end-of-life, see 2026-11-08). Bundle all three into one infra sprint. ([Fastify LTS](https://github.com/fastify/fastify/blob/main/docs/Reference/LTS.md), [Next July release](https://nextjs.org/blog/july-2026-security-release))
- **OpenAI's 2026 changes hit the gateway on several fronts**, beyond the gpt-4o retirement:
  - `openai` v7 requires Node 22.
  - Cache writes are now billed.
  - Luna's default reasoning effort is `medium`.
  - Flex runs at half price.
  - Fine-tuning ends Jan 6 2027.
  - The Evals platform shuts down Nov 30.
  - Plan it as one PR. ([caching](https://developers.openai.com/api/docs/guides/prompt-caching), [deprecations](https://developers.openai.com/api/docs/deprecations))
- **Research and competitors point the same way:** the moat is *trust in results* (strong oracles, no silent passes, poison-resistant memory), not NL→Playwright. That part is commoditized by Playwright Test Agents, WebdriverIO v10 `act()` and Cypress `cy.prompt`. ([WDIO v10](https://www.testmuai.com/blog/webdriverio-v10-release/), [Cypress 15.13](https://www.cypress.io/releases/15-13-0))
- **There are concrete designs for the two biggest product gaps:** SpiderSapien for RECON on SPAs, and governed-memory papers for shared-pool contamination. ([2609.02532](https://arxiv.org/html/2609.02532v1), [2606.24535](https://arxiv.org/html/2606.24535v1))
- **Pricing has settled into a market pattern:** a base fee with an included allowance, a published per-step rate, hard caps, and bring-your-own-key carrying a platform fee. Kaizen's rules-first cost edge should be on the pricing page. ([Momentic pricing](https://momentic.ai/pricing), [Copilot usage billing](https://github.blog/changelog/2026/04/27/github-copilot-is-moving-to-usage-based-billing/))

---

## 2. Relevant to Kaizen, by area

### A. Models, pricing, deprecations, cost tricks
| Date | Item | Why it matters / where | Rating, rec |
|---|---|---|---|
| Oct 20 | **OpenAI prompt-caching overhaul** (GPT-5.6+ and Luna): writes cost 1.25× (30 min) or 2.5× (12 h), reads 0.1×, explicit `prompt_cache_breakpoint`, prewarm, `prompt_cache_key`. ([guide](https://developers.openai.com/api/docs/guides/prompt-caching)) | A prompt cached once and never reused now costs *more*. Put static rules and few-shots before a breakpoint and the ariaSnapshot after it. Use `prompt_cache_key=tenantId`. `llm-gateway/openai.gateway.ts` | **High, adopt** (3.2) |
| — | **Luna gotchas:** default effort `medium`; Chat Completions function calling only works at effort `none`; no fine-tuning. ([model page](https://developers.openai.com/api/docs/models/gpt-6-luna.md)) | `compileStep` and `resolveElement` will slow down and cost more on defaults | **High, adopt** (3.2) |
| Jul 27 | **`openai` v7.0.0 requires Node 22.** v6 changed the tool `output` type. ([v7](https://github.com/openai/openai-node/releases/tag/v7.0.0), [v6](https://newreleases.io/project/github/openai/openai-node/release/v6.0.0)) | You're on 4.104, two majors behind. New caching params need the upgrade. | **High, adopt** (3.2) |
| Jul 30 | **Flex = Batch price** (Luna $0.05/$0.25). Unavailable capacity returns an uncharged 429. ([pricing](https://developers.openai.com/api/docs/pricing), [flex](https://developers.openai.com/api/docs/guides/flex-processing.md)) | Half cost for test-writer RECON/COMPREHEND, Explorer and bulk recompiles. `src/modules/test-writer/` | Med–High, adopt |
| May 7 | **OpenAI winds down self-serve fine-tuning** (no new jobs after Jan 6 2027). ([deprecations](https://developers.openai.com/api/docs/deprecations)) | Rules out a fine-tuned L5 or click-vs-select model on OpenAI. Any future one must be open-weight (Gemma 4 / Qwen3.5). | Med, note |
| Jun 3 | **OpenAI Evals platform shuts down Nov 30.** ([deprecations](https://developers.openai.com/api/docs/deprecations)) | Only matters if the judge or bench uses it | Low, check |
| Apr 22 | **text-embedding-3-small is NOT deprecated** (a viral claim was corrected). ([forum](https://community.openai.com/t/deprecation-notice-upcoming-model-shutdowns-in-2026/1379553)) | No forced re-embed of pgvector | Info |
| Jan 15 | **Voyage 4:** shared embedding space across sizes, Matryoshka 256–2048, int8/binary, open-weight nano. ([blog (2°)](https://hn.jakechampion.name/reader/https://blog.voyageai.com/2026/01/15/voyage-4)) | Best escape hatch if HNSW RAM (issue 2) or vendor lock-in bites. Try halfvec or truncated 3-small first. | Low–Med, watch |
| Jun–Jul | GPT-5.6 Sol/Terra/Luna family. ([Wikipedia](https://en.wikipedia.org/wiki/GPT-5.6)) | Terra is a possible frontier tier for the judge and COMPREHEND | Low, watch |
| Apr / Aug | Gemma 4 (Apache-2.0, function calling + vision), DeepSeek V4-Pro GA with up to 1,100% price rises. ([Gemma](https://siliconangle.com/?p=737125), [DeepSeek](https://www.caixinglobal.com/2026-08-14/tech-brief-aug-14-deepseek-launches-v4-pro-and-raises-api-prices-by-as-much-as-1100-102474222.html)) | A base for an own selector model someday. DeepSeek isn't predictable enough for metered billing. | Low |

### B. Agent harnessing, memory, evals, team tooling
| Date | Item | Why it matters / where | Rating, rec |
|---|---|---|---|
| Jun 3 | **arXiv 2606.04329, memory poisoning:** ~50% success, 67% under permissive write policies, best detector catches 68%. ([paper](https://arxiv.org/html/2606.04329v1)) | Issue 8: defend the *write path* of the shared pool | **High, adopt** (3.4) |
| Jun 23 | **arXiv 2606.24535, governed shared memory:** scopes, a trust ladder, provenance, supersession. 43.9% leakage when scope filters run after search. ([paper](https://arxiv.org/html/2606.24535v1)) | A blueprint for L3/L4 in `element-resolver`. Filter by scope *inside* the pgvector query. | **High, adopt** (3.4) |
| Jun 16 | **arXiv 2606.18168 "All Smoke, No Alarm":** 80.2% of 86k agent-written tests have weak or no oracles. 8-class taxonomy. ([paper](https://arxiv.org/html/2606.18168v1)) | A deterministic pre-judge gate for the vacuity probe and oracle audit | **High, adopt** (3.6) |
| Jun 17 | **arXiv 2606.19544 "Reliability without Validity":** raw agreement overstates judge quality by 33–41 points vs kappa, and position bias persists. ([paper](https://arxiv.org/abs/2606.19544)) | Validate the test-writer judge with kappa and swapped-order runs | **High, adopt** (3.6) |
| ~Oct | **arXiv 2610.11781 Skill-V:** a skill revision is committed only if replay shows no regression. Without the gate, success fell from 95% to 75%. ([paper](https://arxiv.org/html/2610.11781v1)) | Mission 3 self-writing knowledge needs a replay gate plus an applicability check | High, design input |
| May 6 | **Claude Managed Agents "Dreaming" and "Outcomes":** offline consolidation into a *candidate* memory store that you promote explicitly; per-criterion isolated grading. ([summary (2°)](https://mer.vin/2026/05/dreaming-outcomes-and-webhooks-claude-managed-agents-update-may-2026/)) | A pattern for Mission 3 and the judge (complements the Nov 7 memory post) | Med, design input |
| Apr 25 | **arXiv 2604.23178 "Judging the Judges":** style bias is largest; a cheap debiased judge ≈ a frontier judge at 1/15 the cost. ([paper](https://arxiv.org/abs/2604.23178)) | Normalize formatting before judging, then use a cheap judge | Med |
| Apr 4 | **Anthropic three-agent harness:** the evaluator drives the live app; structured handoffs replace compaction. ([InfoQ](https://www.infoq.com/news/2026/04/anthropic-three-agent-harness-ai/)) | Validates the WRITE→judge split. Use handoff artifacts for long Explorer runs. | Med |
| Feb 5 | **SKILL.md is the de facto standard** (VS Code GA, Codex). ([adoption (2°)](https://aictrl.dev/blog/skill-md-adoption-trajectory)) | Mission 3 app-knowledge entries could use SKILL.md format, so customers can export them | Med |
| Jul 28 | **MCP spec 2026-07-28:** stateless core, routing headers, Tasks moved to an extension. ([MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)) | Target this if/when Kaizen ships an MCP server (2-H) | Med |
| Mar / Apr | Claude Code Review (~$15–25 per PR) and Claude Code routines. ([review (2°)](https://dev.to/umesh_malik/anthropic-code-review-for-claude-code-multi-agent-pr-reviews-pricing-setup-and-limits-3o35), [routines (2°)](https://thenewstack.io/claude-code-can-now-do-your-job-overnight/)) | Team speed: use review only on RLS or resolution-chain PRs; run nightly staging Explorer as a routine | Low–Med |
| Jan–Jun | Mastra 1.0, OpenAI Agents SDK revamp, A2A v1.0, memory vendors (Mem0/Zep/Letta). ([OpenAI](https://openai.com/index/the-next-evolution-of-the-agents-sdk/), [A2A](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)) | No reason to switch. BullMQ plus your own pipeline is fine. | Low, ignore |

### C. Browser automation libraries & infra
| Date | Item | Why it matters / where | Rating, rec |
|---|---|---|---|
| Apr–Oct | **Playwright 1.59–1.64 extras:** failure-context and trace aria snapshots (1.60/1.63), `AbortSignal` + `retryStrategy` (1.62), `ariaRef()` removed (1.60), `_react`/`_vue`/`:light` selectors removed (1.58), `--shuffle`. ([releases](https://github.com/microsoft/playwright/releases), [testdino (2°)](https://testdino.com/blog/playwright-2026-new-features/)) | `AbortSignal` lets the step watchdog cancel a step instead of killing the worker (check it works in library mode). Repo grep found no `ariaRef`/`_react`/`:light` in `src/`. | High, part of the 3.2 upgrade in 11-08 |
| Jan–Nov | **Vercel agent-browser:** Rust/CDP, snapshot `--delta`, persistent refs, cursor-interactive elements. ([changelog](https://agent-browser.dev/changelog)) | *Technique* for RECON and issue 6: diff aria snapshots before and after an action to see what a click did, or whether a dependent dropdown has loaded | High (technique), not a dependency |
| Oct 5 | **WebdriverIO v10 `browser.act()`:** LLM steps are recorded and replayed without the model; `$` throws on multiple matches. ([TestMu](https://www.testmuai.com/blog/webdriverio-v10-release/)) | A free open-source version of "compile once, replay deterministically" | Med, threat |
| Mar 23 | **Cypress 15.13 `cy.prompt`** NL steps, on by default. ([release](https://www.cypress.io/releases/15-13-0)) | Same: NL authoring is commoditized | Med, threat |
| Mar–Oct | **Playwright CLI vs MCP:** ~27k vs ~114k tokens per task. ([bug0 (2°)](https://bug0.com/blog/playwright-cli-vs-playwright-mcp-ai-browser-testing-2026)) | A benchmark for Kaizen's pruner token budget, and a marketing number | Med |
| Mar–Oct | **Cloudflare Browser Run:** CDP endpoint, `/accessibilityTree`, 200 concurrent browsers, Chrome 152 default. ([changelog](https://developers.cloudflare.com/changelog/product/browser-run/)) | A burst-capacity option via `connectOverCDP`, only once a version-match test passes | Low–Med, watch |
| Oct 2 | **Lightpanda 1.0:** ~16× less memory, but no screenshots or real layout. ([blog](https://lightpanda.io/blog/posts/lightpanda-1-0)) | Not for execution. At most, cheap link discovery. | Low |
| 2026 | Browser Use 2.0 / Harness, Stagehand, Selenium 4.47, Browserbase Fetch. ([BU](https://browser-use.com/changelog), [Selenium](https://www.selenium.dev/blog/2026/selenium-4-47-released/)) | Reference only | Low |

### D. Anti-bot, bot identity, auth/MFA
| Date | Item | Why it matters / where | Rating, rec |
|---|---|---|---|
| Mar → Oct 29 | **IETF webbotauth adopts its core draft** (`httpsig-protocol-01`, RFC 9421 signatures + key directory). ([datatracker](https://datatracker.ietf.org/wg/webbotauth/)) | The core is now stable enough to build signing on, for worker and Explorer traffic | **High, prototype** (3.8) |
| Aug 28 | **Cloudflare BotBase for Operators:** self-serve submission to become a verified bot; Web Bot Auth accepted as proof. ([blog](https://blog.cloudflare.com/botbase-for-operators/)) | A realistic path to "Verified" status that customers can allow. Kaizen's cloud IPs change, so signing is the only proof that fits. | **High** (3.8) |
| Oct 16 | **Cloudflare "continuous accountability" for verified bots** (robots.txt and 429 behaviour feed trust bands). ([blog](https://blog.cloudflare.com/verified-bots-accountability/)) | Explorer crawl behaviour would affect the reputation of every run. `recon/robots.ts` exists; add 429 backoff. | High, before verifying |
| — | **QA.tech's documented bot-protection recipes:** Cloudflare skip rule, bypass header, Turnstile test keys. ([docs](https://docs.qa.tech/configuration/cloudflare-waf-turnstile)) | Table stakes. `execution-engine/challenge-detector.ts` already detects challenge pages by DOM, so add header signals (`cf-mitigated`) and a setup-guide error. | **High, adopt** (3.8) |
| Jun / Jul | Akamai agentic security framework (KYA) and DataDome Agent Trust (dynamic 0–100 scores). ([Akamai](https://www.globenewswire.com/news-release/2026/06/15/3311619/0/en/Akamai-Unveils-Agentic-Security-Framework-to-Power-Trusted-AI-Driven-Interactions-and-Commerce.html), [DataDome](https://datadome.co/changelog/datadome-product-roundup-q2-2026/)) | One signing setup would be recognized across all three vendors | Med |
| Feb–Aug | **WebMCP** (`document.modelContext`) in a Chrome origin trial until ~Chrome 156. ([explainer (2°)](https://mcpplaygroundonline.com/blog/what-is-webmcp)) | A future test target and Explorer signal. The API is still changing. | Med, watch |
| Ongoing | Mailosaur/MailSlurp TOTP + email-OTP APIs. ([Mailosaur](https://mailosaur.com/docs/authenticator)) | MFA in login recipes. `storageState` is already used (worker/test-writer), so add a TOTP seed per recipe. | Med |
| May 13 | Anti-detect browser benchmark: stealth adds only ~4 points over plain Playwright. ([post](https://ianlpaterson.com/blog/anti-detect-browser-benchmark-patchright-nodriver-curl-cffi/)) | Confirms: don't do stealth, do signed identity | Low (avoid) |

### E. Research: web agents, grounding, test generation
| Date | Paper | Finding → Kaizen use | Rating |
|---|---|---|---|
| Sep 2 | **2609.02532 SpiderSapien** ([arXiv](https://arxiv.org/html/2609.02532v1)) | Interactable-element heuristic, state graph and LLM form-filling: +46% server-side coverage. Answers both RECON gaps. | **High** (3.5) |
| Mar 26 | **2603.25226 WebTestBench** ([arXiv](https://arxiv.org/abs/2603.25226)) | All agents score <30% F1. The gold checklist doubles recall. Agents default to "Pass" with no evidence. → COMPREHEND should infer implicit constraints; the judge should return Inconclusive. | **High** (3.6) |
| Feb 12 | **2602.11724 WebTestPilot** ([arXiv](https://arxiv.org/abs/2602.11724)) | Symbolized elements plus cross-step pre/post-conditions: 96% precision and recall (on the authors' own benchmark). → `count_after == count_before+1` style oracles in WRITE. | High (3.6) |
| May 2 | **2605.01471 Limits of autonomous test repair** ([arXiv](https://arxiv.org/abs/2605.01471v1)) | Repair "converged" partly by deleting or weakening assertions; 38% of reports produced no executable test. → Block heals that weaken assertions. | High (3.6) |
| May | **2605.29397 Minimal Failure Set coverage** ([arXiv](https://arxiv.org/html/2605.29397)) | Offline metric for pruners (ρ>0.7, 290× cheaper). → Regression-test `dom-pruner` changes using logged resolutions. | High, prototype |
| May 12 | **2605.12158 ReproBreak** ([arXiv](https://arxiv.org/abs/2605.12158)) | 449 reproducible real locator breaks (CC BY). → External benchmark for L0–L5 healing, and a publishable "% healed without an LLM". | Med–High |
| Jun 16 | **2606.17929 PreAct** ([arXiv](https://arxiv.org/html/2606.17929)) | Compiled traces with screen-check predicates; verify before storing. → Expected-state predicate on L1–L4 hits; replay before shared promotion. | Med (3.4) |
| May 1 | **2605.00551 A11y-Compressor** ([arXiv](https://arxiv.org/abs/2605.00551)) | ~22% of tokens, +5 points. Modal detection first. → Restrict L5 candidates to the open dialog. | Med, cheap win |
| Apr 2 | **2604.01535 Read More, Think More** ([arXiv](https://arxiv.org/abs/2604.01535)) | Strong models do better with full HTML (+15–18 points); weak ones collapse. → Add layout/visibility cues only when L5 escalates to a strong model. | Med |
| Jun | **2606.16650 Web GUI exploration study** ([arXiv](https://arxiv.org/html/2606.16650v1)) | LLM explorers don't beat classic crawling on coverage. → Use the LLM for forms and for choosing the next feature, not for every step. | Med (3.5) |
| Sep | **2609.35026 WebPageBench** ([arXiv](https://arxiv.org/html/2609.35026v1)) | 87 UI-control variants (date pickers, autocomplete vs select). Agents' own completion claims were off by up to 41 points. → Regression set for issue 5. | Med |
| Aug | **2608.03598 REBUG** ([arXiv](https://arxiv.org/html/2608.03598v1)) | Bug report → reproduction ~50%. Preparing context and data matters more than planning. → Possible "ticket → regression test" feature. | Med, idea |
| Feb 8 | **2602.08146 AdverTest** ([arXiv](https://arxiv.org/abs/2602.08146v1)) | Adversarial mutant agent. → A model for a stronger vacuity probe (LLM-proposed UI mutations). | Med |
| Mar 20 | 2603.20358 Zero-cost a11y-tree self-healing ([arXiv](https://arxiv.org/abs/2603.20358)) | A 10-tier locator ranking. Weak evaluation (one site). A checklist for L0. | Low |
| Jan 13 | 2601.08998 LLM-test flakiness ([arXiv](https://arxiv.org/abs/2601.08998)) | 63% of flaky tests assumed an unguaranteed result order. → Lint order-dependent assertions in WRITE. | Low–Med |

### F. Competitors & market
| Date | Company / item | Threat or idea | Rating |
|---|---|---|---|
| Jun 23 → ~Nov | **Momentic** Agentic Quality Platform (Explore Agent with Jira/Figma context, Failure Classification, intent-based auto-update), then **"Mo"** with QA-Bench (19.3% recall, 84% precision, $2.67 per bug). Pricing: $0.0125/step, $1.25 per heal or triage. ([SiliconANGLE](https://siliconangle.com/2026/06/23/momentic-raises-bar-software-testing-agentic-quality-platform/), [HN](https://news.ycombinator.com/item?id=50339913), [pricing](https://momentic.ai/pricing)) | Ships Missions 3, 4 and 6 first. → Make proven-falsifiability the headline and publish trust metrics. | **High** |
| Apr–Sep | **Octomind shut down** (closest analog to Kaizen's autonomous writer; "lack of market validation"); Bugster and DogQ too, with exports dying alongside them. ([rywalker](https://rywalker.com/research/octomind), [releaseworthy](https://releaseworthy.app/octomind-bugster-dogq-alternatives/)) | Autonomous URL→tests doesn't sell on its own. → Pair it with the triage loop; offer a permanent Playwright export. | **High** (3.7) |
| Aug 4 | **Checksum Continuous Quality Loop:** triage separates real bugs, flaky tests and flaky environments; MCP server; record-to-test extension. ([release](https://www.manilatimes.net/2026/08/04/tmt-newswire/globenewswire/checksum-launches-the-continuous-quality-loop-verification-that-keeps-pace-with-ai-written-code/2398120/amp)) | Mission 4 quarantine needs an *environment-flake* class | High |
| Mid-2026 | **QA Wolf self-serve:** 15¢ per runner-minute + 1¢ per AI credit, Playwright export; managed median ~$90k/yr. ([botgauge](https://www.botgauge.com/blog/qa-wolf-pricing), [bug0](https://bug0.com/knowledge-base/qa-wolf-pricing)) | The "$40k anchor" is gone. Compete on price per run. | High |
| Mar 5 / Jun 11 | **TestSprite** 2.1 (~100k teams claimed) and an open-source CLI whose failure reports include screenshot, DOM, root-cause hypothesis and suggested fix. ([2.1](https://finance.yahoo.com/news/testsprite-2-1-delivers-5x-150000846.html), [CLI](https://siliconangle.com/2026/06/11/testsprite-launches-open-source-command-line-tool-help-ai-agents-check-work/)) | Borrow that failure-report format for Findings and the webhook payload | High (idea) |
| Sep 23 | **UiPath Test Cloud:** Autopilot NL tests, Autonomous Exploration, runs Playwright tests. ([newsroom](https://www.uipath.com/newsroom/uipath-enhances-test-cloud)) | Enterprise rival to Explorer. Position Kaizen for SMB speed and price. | Med |
| Oct 6–21 | **Gartner's first Magic Quadrant for Agentic Software QA** (Leaders: UiPath, Tricentis, TestMu; mabl a Challenger); mabl Agentic Testing Harness. ([MQ guide (2°)](https://rpabotsworld.com/gartner-magic-quadrant-agentic-software-qa-platforms-2026-guide/), [mabl](https://runtimewire.com/article/mabl-agentic-testing-harness-coding-agents)) | The category now has a name, and "independent verifier" framing is mainstream | Med |
| Jul 30 | **Tricentis acquires Tabnine** (an "Enterprise Context Engine" grounding its testing agents). ([Tricentis](https://www.tricentis.com/news/tricentis-acquires-tabnine)) | Per-app knowledge is the battleground; Mission 3 is the right bet | Med |
| Jul–Mar | Meticulous $15M (deterministic browser, session-recorded tests), BrowserStack Test Companion (IDE), TestMu rebrand + KaneAI, Canary (YC, healing chain like Kaizen's), TesterArmy $24/seat. ([Meticulous](https://pulse2.com/meticulous-raises-15-million-series-a-to-accelerate-ai-powered-software-development/), [Canary HN](https://news.ycombinator.com/item?id=47441629), [TesterArmy HN](https://news.ycombinator.com/item?id=48586299)) | A rules-first healing chain is not a moat; price floor pressure | Med |

**Recurring user complaints**, each a chance for Kaizen:
1. Noise and false alarms matter more than recall: "a silent pass on a broken flow is worse than a flaky test".
2. Agents game tests by patching them instead of fixing the bug.
3. Cost and lock-in of proprietary credits; people ask for bring-your-own-key.
4. "Why not just Claude Code + Playwright?"
5. Vendor risk and dead exports.

([HN Mo](https://news.ycombinator.com/item?id=50339913), [HN Canary](https://news.ycombinator.com/item?id=47441629), [Capterra QA Wolf](https://capterra.com/p/229339/QA-Wolf/reviews/))

### G. Node / TS / Postgres / Redis ecosystem & security
| Date | Item | Affects Kaizen? | Rating, rec |
|---|---|---|---|
| Feb 3 / Sep 4 | **Fastify CVE-2026-25223** (<5.7.2, includes v4) and **CVE-2026-76169** (4.0–5.12.2 not-found auth bypass). v4 is end-of-life. ([25223](https://releasealert.dev/cve/CVE-2026-25223), [76169](https://hol.org/blog/cve-2026-76169-fastify-malformed-url-not-found-auth-bypass)) | **Yes**: 4.29.1. No `trustProxy` or `setNotFoundHandler` found in `src/` (lower risk for 3635 and 76169), but 25223 applies to any schema-validated route. | **High, adopt** (3.1) |
| Jul 20 → Nov 3 | **Next.js security releases:** 15.5.21 (July, 9 CVEs including a middleware bypass, SSRF and Server Actions DoS), then 15.5.26–15.5.29 (Sep–Nov, including next/og RCE and image-optimizer SSRF; (2°) tracker). Next 15 lost support Oct 21. ([July](https://nextjs.org/blog/july-2026-security-release), [tracker (2°)](https://pranava0x0.github.io/vibe-coding-security/advisories/2026-09-nextjs-september-2026-security-release-seven-advisories.html), [EOS (2°)](https://www.digitalapplied.com/blog/nextjs-15-end-of-support-october-21-upgrade-options)) | **Yes**: 15.5.15. `middleware.ts` gates `/tests` on cookie presence only. Backend auth still guards the data, but patch it anyway. | **High, adopt** (3.1) |
| Apr 10 / Jul 24 | React Server Components DoS CVE-2026-23869 (fixed 19.2.5) and CVE-2026-44907 (fixed 19.2.8). ([23869](https://advisories.gitlab.com/npm/react-server-dom-webpack/CVE-2026-23869/), [44907](https://feed.craftedsignal.io/briefs/2026-07-react-server-dom-dos/)) | **Yes**: web React 19.2.4. Fixed via the Next upgrade. | High (with #1) |
| May / Jun / Aug | **npm worms:** TanStack (valid provenance), node-gyp `binding.gyp` (bypasses `--ignore-scripts`), ChainDrop (444 packages, plants files in `.claude/`). npm 11.10 adds `min-release-age`. ([Orca](https://orca.security/resources/blog/tanstack-npm-supply-chain-worm/), [Snyk](https://snyk.io/blog/node-gyp-supply-chain-compromise-self-propagating-npm-worm-binding-gyp/), [Microsoft](https://www.microsoft.com/en-us/security/blog/2026/08/04/chaindrop-supply-chain-compromise-anatomy-self-propagating-worm/), [npm](https://github.blog/changelog/2026-02-18-npm-bulk-trusted-publishing-config-and-script-security-now-generally-available/)) | The lockfile has no ChainDrop versions (checked). The risk is future installs. | **High, adopt** (3.3) |
| Aug 13 | **Postgres CVE-2026-14666:** cached RLS policies not re-checked after role or ownership changes (fixed 16.15). Plus 11 CVEs in May. ([PG](https://www.postgresql.org/support/security/CVE-2026-14666/), [May (2°)](https://www.pulse.bot/cybersecurity/news/christophe-pettus-eleven-cves-walk-into-a-release-1ade0a72-6bc2-451b-9c1e-5a20e4f1b905/)) | **Yes**, it matters for the planned unprivileged-role switch (037 notes the runtime is a superuser today) | High (3.3) |
| May 5 | **5 Redis CVEs** (UAF, RESTORE; fixed 7.4.9). ([report (2°)](https://vpncentral.com/?p=249808)) | Yes, unless `7-alpine` was re-pulled. Redis is shared across tenants. | Med (3.3) |
| May 25 | nginx CVE-2026-9256, rewrite heap overflow (fixed 1.30.2/1.31.1). ([AhnLab](https://asec.ahnlab.com/en/93838/)) | Possibly, via `nginx:alpine` if rewrite is used | Med (3.3) |
| — | **pgvector 0.8 tuning:** `hnsw.iterative_scan` (tenant-filtered queries otherwise return too few rows), `halfvec(1536)` halves index RAM. ([README](https://pgxn.org/dist/vector/0.8.0/README.html)) | L3 tenant-filtered search + issue 2 | Med, prototype |
| Jul 8 | TypeScript 7.0 (Go-native, 8–12× faster builds; no compiler API until 7.1). ([Thurrott](https://www.thurrott.com/dev/338669/typescript-7-0-is-here)) | Faster CI typecheck later; ts-jest still needs TS 6 | Low, watch |
| Dec '25 | Docker Hardened Images free. ([dev.to](https://dev.to/docker/docker-just-made-hardened-images-free-for-everyone-lets-check-them-out-499h)) | Candidate base for the Node 24 images | Low |

### H. Dev-tool SaaS pricing & growth
| Date | Item | Idea for Kaizen | Rating |
|---|---|---|---|
| Apr 27 | **GitHub Copilot usage billing:** credits = seat price, budgets per org/cost-center/user, preview bill. ([GitHub](https://github.blog/changelog/2026/04/27/github-copilot-is-moving-to-usage-based-billing/)) | The feature list for issue 3 (plan limits) | **High** (3.7) |
| Jun 20 | **Autumn** (YC W26, Apache-2.0): `check()`/`track()` entitlements over Stripe; used by Browser Use and Firecrawl. ([startuphub (2°)](https://www.startuphub.ai/ai-news/claudes-corner/2026/claudes-corner-autumn-yc-w2026)) | The quickest way to plan limits on top of `billing_events` | High, prototype |
| Mar 2 | **Stripe token billing** (auto-markup on model prices, through Metronome). ([TechCrunch](https://techcrunch.com/2026/03/02/stripe-wants-to-turn-your-ai-costs-into-a-profit-center), [docs](https://docs.stripe.com/billing/token-billing)) | The alternative to Autumn; protects margin when model prices change | Med |
| Feb / Jun | **Cursor and Vercel charge a $0.25/1M platform rate even for bring-your-own-key.** ([Cursor (2°)](https://flexprice.io/pricing-index/cursor), [Vercel](https://vercel.com/changelog/vercel-agent-has-updated-pricing)) | If bring-your-own-key comes (issue 4), never make it free | Med |
| Jan 26 | **MCP Apps** (in-chat UIs in Claude, ChatGPT, VS Code) and directory listings. ([alpic (2°)](https://alpic.ai/blog/mcp-apps-goes-official-claude-chatgpt-support)) | A thin Kaizen MCP server ("run/heal results card", `create_trial_workspace`) as a distribution channel | Med |
| Mar–Apr | **Delve SOC 2 scandal** (templated audits). ([report (2°)](https://captaincompliance.com/news/the-delve-scandal-fake-soc-2-audits-open-source-code-theft-and-exit-from-y-combinator/)) | Use Vanta or Drata with a known CPA firm, and put up a trust page early | Med |

---

## 3. Deep dives

### 3.1 Web & API security (Next 15 + Fastify 4)
- **Next (`packages/web`):**
  - Bump to `15.5.29` now. That brings the patched bundled RSC and covers the July and Sep–Nov fixes. Also bump `react`/`react-dom` to the latest patched 19.2.x.
  - `middleware.ts` only redirects on cookie *presence*. That's fine as UX, provided every `/api/proxy` call and the Fastify routes validate the token, which CLAUDE.md requires. Add a test proving a forged cookie gets a 401 from the backend.
  - Next 16 work:
    - `middleware.ts` becomes `proxy.ts`.
    - Edge runtime is deprecated.
    - `unstable_cache` becomes `use cache`.
    - Schedule it after the Node 24 bump. Budget 2–3 days, mostly the build and the `(app)` route group.
- **Fastify (`src/api`):**
  - Major changes for 5.x:
    - Full JSON-schema for querystring/params/body.
    - `reply.redirect(url, code)` argument order.
    - Logger option changes.
    - Plugin version bumps (`@fastify/*`).
  - The grep found no `trustProxy` or `setNotFoundHandler`, so CVE-2026-3635 and -76169 exposure is low today. CVE-2026-25223 hits any route relying on body schemas, so treat it as High.
  - Plan: Node 24 → Fastify 5.12.x → run the full jest + integration suite (`jest.integration.config.ts`).
- **Effort / risk:** ~1 day patch and ~3–4 days for the majors. Risk is low to medium, and the test suite covers it.

### 3.2 LLM gateway modernization
This builds on 11-08 §3.1 (gpt-4o → Luna) and Addendum 2 (Decisions API, Node 24). Order:
1. Node 24 images and CI (see 11-08 Addendum 2).
2. `openai` 4.104 → 7.x. Check the v6 tool-`output` type change in `openai.gateway.ts`. Chat Completions is not deprecated, so moving to the Responses API is optional; it is needed only for cache TTL and prewarm, and for tools at non-zero reasoning effort.
3. Luna settings: set `reasoning_effort:"none"` explicitly for `compileStep`/`resolveElement`, and keep structured outputs.
4. Cache layout:
   - Order: static system prompt → archetype rules / few-shots → `prompt_cache_breakpoint` → ariaSnapshot candidates.
   - Set `prompt_cache_key = tenantId`.
   - Prewarm at run start for big suites.
   - Log `cached_tokens` and cache-write tokens into `billing_events`. Fix `embedding-tokens-not-tracked` in the same pass.
5. Route test-writer and Explorer calls through **Flex** (`service_tier:"flex"`), with a ~15 min timeout and retry-then-Standard on 429.
6. Remove the unused `@anthropic-ai/sdk@0.39`, or bump it to ~0.91 if you want the Haiku 5.5 fallback.

- **Bench:** judge-lite campaign, hot-phase token count, L5 accuracy and click-vs-select probes (issue 5), against the 4o baseline.
- **Effort:** 3–4 days.
- **Payoff:** Luna list price is below 4o-mini, Flex halves background cost, and you avoid the hard-fail on Jan 14 2027.

### 3.3 Supply chain & data-tier images
- **npm:**
  - Add `.npmrc` with `min-release-age=7` (npm ≥11.10 ships with Node 24).
  - Use `npm ci` everywhere, including the Dockerfiles.
  - Use `--ignore-scripts` where builds allow (sharp and Playwright need care).
  - Set `allow-git=none`.
  - In `.github/workflows/ci.yml`: no `pull_request_target`, `permissions:` minimal, no cache shared between PR and release jobs.
  - Add `.claude/` and `.vscode/` drift to the review checklist (ChainDrop planted files there).
  - The lockfile is clean today (flat-cache 4.0.1, file-entry-cache 8.0.0, keyv 4.5.4).
- **Images:**
  - Pin by digest: `pgvector/pgvector:0.8.x-pg16` on PG ≥16.15, `redis:7.4.9-alpine` (or Valkey for a BSD license), `nginx:1.30.2-alpine`+.
  - Verify the production DB minor version too.
  - **Do CVE-2026-14666 before the 036/037 unprivileged-role switch.** Otherwise sessions keep stale policy access after role changes.
- **Effort:** ½ day.

### 3.4 Shared-pool write-path governance (issue 8)
- **Current state:** promotion to `is_shared=true, tenant_id IS NULL` is gated per tenant by `global_brain_opt_in` (037). The runtime is a superuser, so RLS is inert.
- **Changes (from 2606.04329, 2606.24535 and PreAct):**
  1. **Promotion rule:** a shared row requires ≥N (e.g. 3) *distinct tenants*, each with successful executions, or a crawler or replay verification.
  2. **Provenance columns:** `source_tenant_count`, `confirmations`, `last_confirmed_at`, `superseded_by`, `state ∈ {candidate, shared, quarantined}`.
  3. **Scope inside the query:** apply `WHERE (tenant_id = $t OR (is_shared AND state='shared'))` in the same pgvector `ORDER BY embedding <=> $q` statement. Never filter after retrieval. Set `hnsw.iterative_scan=relaxed_order` so filtered queries still return k rows.
  4. **Expected-state predicate:** store a URL pattern plus a landmark/anchor signature with each cache row, and reject an L1–L4 hit on mismatch. This also catches confident wrong clicks.
  5. **Quarantine:** one tenant's failure *demotes* a shared row to quarantined (it is not deleted). Decay rows that aren't re-confirmed within X days.
- **Effort:** ~1 week, with a migration and resolver changes in `element-resolver/` (L3/L4).
- **Risk:** a slightly lower shared hit rate early on. Measure it on the bench.

### 3.5 RECON state-graph explorer
Target: `src/modules/test-writer/recon/crawler.ts`, which fixes `spa-button-navigation-invisible-to-recon.md` and the form-submit depth gap (roadmap Mission 5).
- **Candidates:**
  - `a`, `button`, `[role=button|tab|menuitem|link]`, plus elements with computed `cursor:pointer` or `tabIndex>=0`.
  - Filter by visibility and an `elementFromPoint` hit test.
  - Drop nested duplicates.
- **Route capture:** use `addInitScript` to hook `history.pushState`/`replaceState` and `popstate`.
- **State identity:** normalized URL plus a hash of a pruned `ariaSnapshot()` (landmarks and headings). This is the piece SpiderSapien leaves out.
- **Exploration:**
  - Put new actions first, within a BFS budget, and retrace to return to earlier states.
  - Denylist destructive labels (delete, logout, pay).
  - Respect `recon/robots.ts`, and back off on 429.
- **Forms:**
  - The LLM returns `[{selector, value}]` with synthetic-safe data.
  - A "dangerous form" check (password change, account deletion, payment) runs first.
  - Submitting stays consent-gated, per the authenticated-scope spec.
- **Use the LLM sparingly:** for forms and for choosing the next feature only (2606.16650: LLM-per-step exploration doesn't beat classic crawling).
- **Effort:** 1–2 weeks. Bonus: the same before/after snapshot diff gives an "await dependent dropdown populated" signal for issue 6.

### 3.6 Test-writer quality gates
Target: `src/modules/test-writer/` (WRITE, judge, oracle audit, vacuity probe).
1. **Oracle-strength lint (deterministic, before the judge):**
   - Classify each assertion. Weak: visible, URL changed, exists, boolean-only. Strong: value, text or count equality, state relative to a prior step.
   - Re-prompt or reject tests with only weak oracles (2606.18168).
2. **Cross-step symbolic oracles:** capture values earlier in the test (cart count, row count, total) and assert relative changes (2602.11724).
3. **Assertion-weakening guard:** diff assertion count and specificity before and after any LLM repair or heal, and block or escalate any decrease (2605.01471).
4. **Judge:**
   - "No evidence" counts as Inconclusive, never Pass (2603.25226).
   - Grade each rubric criterion in its own call.
   - Normalize formatting before judging.
   - Validate on ~100 hand-labelled tests with Cohen's kappa and swapped order (2606.19544, 2604.23178).
5. **COMPREHEND:** add an "implicit constraints" pass covering uniqueness, limits and permissions, the gap WebTestBench found.

- **Effort:** 3–5 days.
- **Payoff:** this is the "proven-falsifiable findings" story that answers Momentic and Checksum, and the top HN complaints.

### 3.7 Pricing, plan limits & export escrow
- **Model:**
  - Base fee with an included $ allowance.
  - Published rate card: plain replay and rule-based (L0–L4) heals are $0 or 1 step; LLM heal ~$0.25; test-writer job priced per page or flow.
  - Hard caps by default (runs pause at $0), with org and user budgets and a projected-bill preview (Copilot pattern).
  - Benchmarks: Momentic $0.0125/step and $1.25/heal; QA Wolf self-serve 15¢/runner-min.
- **Build:** Autumn `check()` before compile, run and writer jobs, and `track()` after, fed from `billing_events`. Or Stripe token billing. Either closes issues 3 and 4 (bring-your-own-key later, with a platform fee).
- **Marketing proof:** show "% of heals with zero LLM calls" and tokens per heal on the dashboard and pricing page. Use ReproBreak to get an external number.
- **Escrow:** a permanent "export suite as plain Playwright" that runs without Kaizen. After the Octomind, Bugster and DogQ shutdowns it's a sales argument.
- **Effort:** 1–2 weeks.

### 3.8 Bot-protection onboarding & signed agent
- **Now (days):**
  1. A per-project rotating secret header sent on every request (Playwright `extraHTTPHeaders`), plus copy-paste Cloudflare, Akamai and DataDome skip-rule templates.
  2. Recommend Turnstile, reCAPTCHA and hCaptcha test keys on staging.
  3. Extend `challenge-detector.ts` with response signals (403/429 + `cf-mitigated`, DataDome/Akamai markers), and show "Blocked by bot protection → setup guide" instead of a test failure.
  4. A TOTP seed per login recipe (RFC 6238, retry at the window edge). `storageState` reuse already exists.
- **Next (1–2 weeks):**
  - Ed25519 key, plus a key directory under a Kaizen domain.
  - RFC 9421 signing via a small forward proxy in each worker (cleaner than `page.route`).
  - A `KaizenBot` UA token with a contact URL.
  - Submit through Cloudflare BotBase as "agent acting for a user".
  - Give Explorer 429 backoff first, because its trust band depends on it.
- **Don't:** use stealth or patched browsers. They gain ~4 points and would cost Verified status.

---

## 4. Other news (not relevant)
- Browserbase Fetch API ($1 per 1k pages); targets need JavaScript, so no. ([blog](https://www.browserbase.com/blog/fetch-api))
- Qodo $70M Series B, focused on code review. ([pulse (2°)](https://www.pulse.bot/venture-capital/news/qodo-raises-70m-series-b-5cf1a31a-d1f6-4621-b649-318e786c51e4/))
- Stripe completes Metronome ($1B) and Adyen buys Orb ($335M); the usage-billing vendors are being bought up. ([Stripe](https://stripe.com/newsroom/news/stripe-completes-metronome-acquisition), [Paypers](https://thepaypers.com/mergers-aquisitions-and-investments/news/adyen-to-acquire-enterprise-billing-platform-orb-for-usd-335-million))
- Gemini Embedding 2 (multimodal, $0.20/1M) is too expensive for L3/L4. ([apiyi (2°)](https://docs.apiyi.com/en/news/gemini-embedding-2-preview-launch))
- GPT-5.4 mini/nano are more expensive than Luna. ([gigazine](https://gigazine.net/gsc_news/en/20260318-openai-gpt-5-4-mini-nano))
- OpenAI Assistants API shut down Aug 26 (Kaizen doesn't use it). ([deprecations](https://developers.openai.com/api/docs/deprecations))
- Cloudflare isitagentready.com (agent-readiness scorer). ([VKTR](https://www.vktr.com/ai-news/cloudflare-agents-week/))
- Google is testing Web Bot Auth for some agents. ([pulse (2°)](https://www.pulse.bot/ai/news/web-bot-auth-googles-new-experimental-method-to-validate-authentic-bots-b4e0ca0c-6869-4160-a2a6-a3bf4dce081d/))
- Cursor Bugbot 2.0 and `/automate`. ([fourweekmba (2°)](https://fourweekmba.com/cursor-bugbot-automate-cloud-subagents-spacex/))
- Redis 8 adds an AGPL option; Valkey stays BSD. ([support.tools](https://support.tools/redis-open-source-again/))
- Postgres 18 features (async I/O, uuidv7, OAuth). Kaizen is on 16; consider them at the next major. ([press kit](https://www.postgresql.org/about/press/presskit18))
- No 2026 news found for Rainforest QA, Autify, Testsigma, Katalon, Spur, Ranger, Tusk, Propel or Docket.
