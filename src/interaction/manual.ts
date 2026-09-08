import type { Page } from '../automation/types.js';
import type { ControlDescriptor } from '../types.js';
import type { ManualGate } from '../state/manualGate.js';
import type { RemoteControl } from '../server/remoteControl.js';
import {
  editableLocator,
  ensureInteractable,
  notFound,
  openControlOverlay,
  resolveSelector,
  reveal,
  type HandlerContext,
  type HandlerResult,
} from './handlers.js';
import { log } from '../util/logger.js';

/**
 * Manual data-entry step.
 *
 * Runs in place of a control's normal handler when the operator selected
 * Manual mode. Everything up to "found and interactable" is the exact same
 * pipeline Automatic mode uses (`resolveSelector`, `reveal`,
 * `ensureInteractable`) — this only replaces the fill itself: instead of
 * clicking/typing/selecting, it scrolls the control into view, highlights it
 * in the visible browser window so the operator can find it, and waits for
 * confirmation from the web UI before capturing the same way `ctx.capture()`
 * always has.
 */
export async function runManualStep(
  control: ControlDescriptor,
  ctx: HandlerContext,
  gate: ManualGate,
  remote?: RemoteControl,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) {
    gate.setItemStatus(control.dedupeKey, 'skipped');
    return notFound(control);
  }

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) {
    gate.setItemStatus(control.dedupeKey, 'waiting');
    return blocked;
  }

  await highlight(ctx.page, selector);

  /*
   * Dropdowns, calendars and lookups all hide a trigger the operator would
   * otherwise have to find and click themselves inside the live view before
   * they could even see what to pick from -- confirmed as a real friction
   * point on a live run (Company Code's value-help icon). Automatic mode
   * already knows exactly how to open each of these kinds; reused verbatim
   * via `openControlOverlay` (the same function, same selectors) so the
   * operator's very first frame already shows the open list/calendar/dialog,
   * ready to click into. Deliberately NOT extended to actionButton/
   * revealButton: those may perform a real action or reveal something
   * unknown, which manual mode leaves entirely to the operator's own
   * judgement rather than clicking on their behalf.
   */
  if (
    control.kind === 'select' ||
    control.kind === 'multiSelect' ||
    control.kind === 'valueHelp' ||
    control.kind === 'date' ||
    control.kind === 'dateRange'
  ) {
    await openControlOverlay(control, ctx, loc, selector).catch(() => undefined);
  } else if (control.kind === 'input' || control.kind === 'textarea') {
    /*
     * The text box in the web UI sends typed characters via
     * `page.keyboard.insertText`, which lands wherever the REAL page's DOM
     * focus currently is -- not wherever the operator is looking. Nothing
     * up to this point ever focuses the field itself (`highlight()` only
     * draws an outline), so a field became active, the operator typed
     * straight into the box, and the keystrokes landed nowhere (or on
     * whatever the previous field left focused) unless they first clicked
     * the exact right pixel inside the live image. Same fix as the overlay
     * auto-open above, for the same reason: resolve the real editable
     * element (the wrapper's inner <input>, same as Automatic mode's
     * `handleTextual`) and focus it automatically. Triple-click selects any
     * existing value so the operator's typed text replaces it, matching
     * `fill()`'s full-replace behaviour in Automatic mode, rather than
     * inserting in the middle of or after whatever was already there.
     */
    const target = await editableLocator(ctx.page, selector);
    await target
      .click({ timeout: ctx.budgets.controlTimeoutMs, clickCount: 3 })
      .catch(() => undefined);
  }

  const label = control.canonicalLabel || control.label || control.id;
  log.debug(`  [manual] waiting on operator for "${label}"`);

  await remote?.start();

  let action: 'submit' | 'skip';
  try {
    action = await gate.activate(control.dedupeKey);
  } finally {
    await remote?.stop();
    await unhighlight(ctx.page);
  }

  if (action === 'skip') {
    gate.setItemStatus(control.dedupeKey, 'skipped');
    return { documented: false, note: 'skipped by operator (manual mode)' };
  }

  // Verify the submitted value
  if (control.kind === 'input' || control.kind === 'textarea') {
    const submittedValue = gate.getSubmittedValue(control.dedupeKey);
    const verified = await verifyFieldSubmission(
      ctx.page,
      control,
      selector,
      submittedValue,
    );
    if (!verified) {
      log.warn(
        `  [manual] field "${label}" verification failed; retaining for operator`,
      );
      gate.setItemStatus(control.dedupeKey, 'waiting');
      return {
        documented: false,
        note: 'field verification failed (value mismatch or invalid state); please try again',
      };
    }
  } else if (
    control.kind === 'select' ||
    control.kind === 'multiSelect' ||
    control.kind === 'valueHelp' ||
    control.kind === 'date' ||
    control.kind === 'dateRange'
  ) {
    // For selection controls, verify the actual selection state
    const verified = await verifySelectionSubmission(ctx.page, control, selector);
    if (!verified) {
      log.warn(
        `  [manual] selection "${label}" verification failed; retaining for operator`,
      );
      gate.setItemStatus(control.dedupeKey, 'waiting');
      return {
        documented: false,
        note: 'selection verification failed; please try again',
      };
    }
  }

  await ctx.capture();
  gate.setItemStatus(control.dedupeKey, 'completed');
  return { documented: true };
}

const HIGHLIGHT_ATTR = 'data-ui-doc-engine-active';

/** Adds a visible outline so the operator can spot the active control. */
async function highlight(page: Page, selector: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate((el: Element, attr: string) => {
      const target = el as HTMLElement;
      target.setAttribute(attr, '1');
      target.style.setProperty('outline', '3px solid #e11d48', 'important');
      target.style.setProperty('outline-offset', '2px', 'important');
    }, HIGHLIGHT_ATTR)
    .catch(() => undefined);
}

/** Removes the highlight added by `highlight()`. */
async function unhighlight(page: Page): Promise<void> {
  await page
    .locator(`[${HIGHLIGHT_ATTR}]`)
    .first()
    .evaluate((el: Element, attr: string) => {
      const target = el as HTMLElement;
      target.removeAttribute(attr);
      target.style.removeProperty('outline');
      target.style.removeProperty('outline-offset');
    }, HIGHLIGHT_ATTR)
    .catch(() => undefined);
}

/**
 * Verifies that a selection control has an actual selection made.
 * Checks that the control transitioned to a "selected" state, not just has text.
 */
async function verifySelectionSubmission(
  page: Page,
  control: ControlDescriptor,
  selector: string,
): Promise<boolean> {
  try {
    const result = await page
      .locator(selector)
      .first()
      .evaluate((el: Element, kind: string) => {
        const target = el as HTMLElement;

        // Native select element: must have selected option with non-empty value
        if (el instanceof HTMLSelectElement) {
          const selected = el.selectedIndex > 0 && el.value !== '';
          if (!selected) {
            return { valid: false, reason: 'no option selected' };
          }
          return { valid: true };
        }

        // For date and dateRange: must have actual date value set
        if (kind === 'date' || kind === 'dateRange') {
          const value = (target as HTMLInputElement).value;
          if (!value) {
            return { valid: false, reason: 'no date selected' };
          }
          return { valid: true };
        }

        // For select/multiSelect: check UI5-specific attributes and state
        if (kind === 'select' || kind === 'multiSelect') {
          // UI5 ComboBox has data-value or value on the trigger
          const dataValue = target.getAttribute('data-value');
          const attrValue = target.getAttribute('value');

          if (dataValue && dataValue !== '') return { valid: true };
          if (attrValue && attrValue !== '') return { valid: true };

          // Check if input within control has value
          const input = target.querySelector('input');
          if (input && input.value && input.value !== '') {
            return { valid: true };
          }

          return { valid: false, reason: 'no value selected in control' };
        }

        // For valueHelp: the trigger should show a selected row/value
        if (kind === 'valueHelp') {
          // Check for a value input within the control
          const input = target.querySelector('input[type="text"]');
          if (input && (input as HTMLInputElement).value) {
            return { valid: true };
          }

          // Check for display text that indicates selection
          const displayText = target.innerText?.trim() ?? '';
          if (displayText && !displayText.includes('...')) {
            return { valid: true };
          }

          return { valid: false, reason: 'no row selected in value help' };
        }

        return { valid: false, reason: 'unknown selection control' };
      }, control.kind)
      .catch(() => ({ valid: false, reason: 'evaluation-failed' }));

    if (!result.valid) {
      log.debug(`  [manual] selection verification failed: ${result.reason}`);
      return false;
    }

    return true;
  } catch {
    log.debug('  [manual] selection verification error');
    return false;
  }
}

/**
 * Verifies that a text/numeric field submission is valid.
 * Checks that the actual DOM value matches what was submitted and is not in error state.
 */
async function verifyFieldSubmission(
  page: Page,
  control: ControlDescriptor,
  selector: string,
  submittedValue?: string,
): Promise<boolean> {
  try {
    const result = await page
      .locator(selector)
      .first()
      .evaluate(
        (el: Element, expected: string | undefined) => {
          const target = el as HTMLInputElement | HTMLTextAreaElement;
          const actual = target.value?.trim() ?? '';

          // Check if field is empty
          if (!actual) {
            return { valid: false, reason: 'empty' };
          }

          // If we have an expected value, verify it matches (allowing for whitespace/normalization)
          if (expected !== undefined) {
            const normalizeForComparison = (s: string) =>
              s.toLowerCase().trim().replace(/\s+/g, ' ');
            if (
              normalizeForComparison(actual) !==
              normalizeForComparison(expected)
            ) {
              return {
                valid: false,
                reason: `mismatch: expected "${expected}", got "${actual}"`,
              };
            }
          }

          // Check for client-side validation errors
          if ('validity' in target) {
            const validity = (target as HTMLInputElement).validity;
            if (validity && !validity.valid) {
              return {
                valid: false,
                reason: `invalid: ${validity.typeMismatch ? 'type' : validity.rangeUnderflow ? 'range' : 'constraint'}`,
              };
            }
          }

          // Check for aria-invalid attribute (framework validation)
          if (target.getAttribute('aria-invalid') === 'true') {
            return { valid: false, reason: 'aria-invalid' };
          }

          // Check for common framework error indicators
          const parent = target.parentElement;
          if (
            parent?.classList.contains('sapUiInvalid') ||
            parent?.classList.contains('is-invalid') ||
            parent?.classList.contains('error') ||
            target.classList.contains('sapUiInvalid') ||
            target.classList.contains('is-invalid') ||
            target.classList.contains('error')
          ) {
            return { valid: false, reason: 'framework-error' };
          }

          return { valid: true };
        },
        submittedValue,
      )
      .catch(() => ({ valid: false, reason: 'evaluation-failed' }));

    if (!result.valid) {
      log.debug(`  [manual] field validation failed: ${result.reason}`);
      return false;
    }

    return true;
  } catch {
    log.debug('  [manual] field verification error');
    return false;
  }
}
