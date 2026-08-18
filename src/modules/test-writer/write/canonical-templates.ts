import type { StepAST } from '../../../types';
import type { GroundingElement, StepIntent, StepIntentTarget } from '../../../types/test-writer';
import { stepContentHash, stepTargetHash } from '../../test-compiler/learned.compiler';

/**
 * Canonical renderer — one template per action, phrased in the compiler's own
 * grammar. Every intent yields BOTH artefacts:
 *   1. the NL sentence — still the user-facing interface (reviewed, edited, owned)
 *   2. the StepAST — constructed directly, because the writer knows the action,
 *      target and value definitionally. No LLM re-compile, no parse gamble.
 *
 * Spec: docs/specs/test-writer/spec-generation-pipeline.md §3
 *
 * The AST is stored on test_steps.compiled_ast and NEVER written to the global
 * compiled_ast_cache — rendered sentences embed tenant element names and urls,
 * and that table is tenant-free (isolation invariant, service spec §11).
 */

export type RenderedStep = {
  text: string;
  ast: StepAST;
};

/** ARIA role → the noun a human uses for it. */
const ROLE_NOUN: Record<string, string> = {
  button: 'button',
  link: 'link',
  textbox: 'field',
  searchbox: 'search field',
  combobox: 'dropdown',
  listbox: 'dropdown',
  checkbox: 'checkbox',
  radio: 'radio button',
  switch: 'toggle',
  tab: 'tab',
  menuitem: 'menu item',
  form: 'form',
  heading: 'heading',
  img: 'image',
};

/**
 * Natural-language description of a crawled element: `the "Sign in" button`.
 * This is what becomes `targetDescription` — and therefore what the element
 * resolver will be asked to find at run time, so it must read like something a
 * QA engineer would write, not like a selector.
 */
export function describeElement(element: GroundingElement): string {
  const noun = ROLE_NOUN[element.role] ?? 'element';
  const name = element.name.trim();
  if (!name) return `the ${noun}`;
  return `the "${name}" ${noun}`;
}

export function describeTarget(
  target: StepIntentTarget,
  elements: Map<string, GroundingElement>,
): string {
  if (target.kind === 'description') return target.description;
  const element = elements.get(target.elementId);
  return element ? describeElement(element) : 'the element';
}

/**
 * A description target on an assertion IS the definition of a discover oracle:
 * the crawler never saw this element, because it only exists after the action
 * the scenario just performed (a flash message, a new row, a confirmation). The
 * worker must therefore resolve it inside what that action changed, and nowhere
 * else — resolving it against the whole page is how "verify the confirmation is
 * visible" bound to the button that produced it.
 * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §1
 */
function deltaScope(target: StepIntentTarget | undefined): 'delta' | undefined {
  return target?.kind === 'description' ? 'delta' : undefined;
}

function buildAst(params: {
  action: StepAST['action'];
  text: string;
  targetDescription?: string | null;
  value?: string | null;
  url?: string | null;
  captureAs?: string | null;
  oracleScope?: 'delta';
}): StepAST {
  const targetDescription = params.targetDescription ?? null;
  return {
    action: params.action,
    targetDescription,
    value: params.value ?? null,
    url: params.url ?? null,
    rawText: params.text,
    contentHash: stepContentHash(params.text),
    targetHash: stepTargetHash(params.action, targetDescription),
    ...(params.captureAs ? { captureAs: params.captureAs } : {}),
    ...(params.oracleScope ? { oracleScope: params.oracleScope } : {}),
  };
}

/**
 * Render one intent. `elements` maps page_elements.id → element, so the
 * renderer can turn a grounded id into the sentence a human will read.
 */
export function renderIntent(
  intent: StepIntent,
  elements: Map<string, GroundingElement>,
): RenderedStep {
  const target = (): string => describeTarget((intent as { target: StepIntentTarget }).target, elements);

  switch (intent.action) {
    case 'navigate': {
      const text = `navigate to ${intent.url}`;
      return { text, ast: buildAst({ action: 'navigate', text, url: intent.url }) };
    }
    case 'go_back':
      return { text: 'go back', ast: buildAst({ action: 'go_back', text: 'go back' }) };
    case 'go_forward':
      return { text: 'go forward', ast: buildAst({ action: 'go_forward', text: 'go forward' }) };
    case 'reload':
      return { text: 'reload the page', ast: buildAst({ action: 'reload', text: 'reload the page' }) };
    case 'close_tab':
      return { text: 'close the tab', ast: buildAst({ action: 'close_tab', text: 'close the tab' }) };
    case 'switch_tab': {
      const text = `switch to the ${intent.value} tab`;
      return { text, ast: buildAst({ action: 'switch_tab', text, value: intent.value }) };
    }

    case 'click': {
      const text = `click ${target()}`;
      return { text, ast: buildAst({ action: 'click', text, targetDescription: target() }) };
    }
    case 'double_click': {
      const text = `double click ${target()}`;
      return { text, ast: buildAst({ action: 'double_click', text, targetDescription: target() }) };
    }
    case 'right_click': {
      const text = `right click ${target()}`;
      return { text, ast: buildAst({ action: 'right_click', text, targetDescription: target() }) };
    }
    case 'hover': {
      const text = `hover over ${target()}`;
      return { text, ast: buildAst({ action: 'hover', text, targetDescription: target() }) };
    }
    case 'check': {
      const text = `check ${target()}`;
      return { text, ast: buildAst({ action: 'check', text, targetDescription: target() }) };
    }
    case 'uncheck': {
      const text = `uncheck ${target()}`;
      return { text, ast: buildAst({ action: 'uncheck', text, targetDescription: target() }) };
    }
    case 'clear': {
      const text = `clear ${target()}`;
      return { text, ast: buildAst({ action: 'clear', text, targetDescription: target() }) };
    }

    case 'type': {
      const text = `type "${intent.value}" in ${target()}`;
      return { text, ast: buildAst({ action: 'type', text, targetDescription: target(), value: intent.value }) };
    }
    case 'select': {
      const text = `select "${intent.value}" from ${target()}`;
      return { text, ast: buildAst({ action: 'select', text, targetDescription: target(), value: intent.value }) };
    }

    case 'drag_and_drop': {
      const source = describeTarget(intent.target, elements);
      const destination = describeTarget(intent.destination, elements);
      const text = `drag ${source} to ${destination}`;
      // The compiler encodes drag destinations in `value` (openai.gateway.ts).
      return { text, ast: buildAst({ action: 'drag_and_drop', text, targetDescription: source, value: destination }) };
    }

    case 'click_random': {
      // The description names a class of elements and usually carries its own
      // article ("an add to cart button") — keep the sentence readable.
      const noun = intent.description.replace(/^(?:a|an|the)\s+/i, '');
      const text = `click a random ${noun}`;
      return {
        text,
        ast: buildAst({
          action: 'click_random', text,
          targetDescription: intent.description,
          captureAs: intent.captureAs,
        }),
      };
    }

    case 'assert_visible': {
      const text = `verify ${target()} is visible`;
      return { text, ast: buildAst({ action: 'assert_visible', text, targetDescription: target(), oracleScope: deltaScope(intent.target) }) };
    }
    case 'assert_not_visible': {
      const text = `verify ${target()} is not visible`;
      return { text, ast: buildAst({ action: 'assert_not_visible', text, targetDescription: target() }) };
    }
    case 'assert_enabled': {
      const text = `verify ${target()} is enabled`;
      return { text, ast: buildAst({ action: 'assert_enabled', text, targetDescription: target(), oracleScope: deltaScope(intent.target) }) };
    }
    case 'assert_disabled': {
      const text = `verify ${target()} is disabled`;
      return { text, ast: buildAst({ action: 'assert_disabled', text, targetDescription: target(), oracleScope: deltaScope(intent.target) }) };
    }
    case 'assert_checked': {
      const text = `verify ${target()} is checked`;
      return { text, ast: buildAst({ action: 'assert_checked', text, targetDescription: target(), oracleScope: deltaScope(intent.target) }) };
    }

    case 'assert_text': {
      const where = intent.target ? describeTarget(intent.target, elements) : null;
      const text = where
        ? `verify ${where} contains "${intent.value}"`
        : `verify the text "${intent.value}" is shown`;
      return { text, ast: buildAst({ action: 'assert_text', text, targetDescription: where, value: intent.value, oracleScope: deltaScope(intent.target) }) };
    }
    case 'assert_not_text': {
      const text = `verify the text "${intent.value}" is not shown`;
      return { text, ast: buildAst({ action: 'assert_not_text', text, value: intent.value }) };
    }
    case 'assert_url': {
      const text = `verify the url contains "${intent.value}"`;
      return { text, ast: buildAst({ action: 'assert_url', text, value: intent.value }) };
    }
    case 'assert_title': {
      const text = `verify the page title contains "${intent.value}"`;
      return { text, ast: buildAst({ action: 'assert_title', text, value: intent.value }) };
    }
    case 'assert_attribute': {
      const where = describeTarget(intent.target, elements);
      const text = `verify ${where} has ${intent.attribute} "${intent.expected}"`;
      // The engine expects `attribute=expected` in value.
      return {
        text,
        ast: buildAst({
          action: 'assert_attribute', text,
          targetDescription: where,
          value: `${intent.attribute}=${intent.expected}`,
          oracleScope: deltaScope(intent.target),
        }),
      };
    }

    case 'press_key': {
      const text = `press ${intent.value}`;
      return { text, ast: buildAst({ action: 'press_key', text, value: intent.value }) };
    }
    case 'wait': {
      const text = `wait ${intent.value} milliseconds`;
      return { text, ast: buildAst({ action: 'wait', text, value: intent.value }) };
    }
    case 'scroll': {
      const where = intent.target ? describeTarget(intent.target, elements) : null;
      const text = where ? `scroll to ${where}` : 'scroll down the page';
      return { text, ast: buildAst({ action: 'scroll', text, targetDescription: where }) };
    }

    default: {
      // Exhaustiveness guard: a new StepAction must get a template before it can
      // be generated. Failing loudly here beats emitting an unrunnable step.
      const exhaustive: never = intent;
      throw new Error(`No canonical template for intent: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function renderScenario(
  intents: StepIntent[],
  elements: Map<string, GroundingElement>,
): RenderedStep[] {
  return intents.map((intent) => renderIntent(intent, elements));
}
