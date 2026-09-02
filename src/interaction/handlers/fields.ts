import type { Locator, Page } from '../../automation/types.js';
import type { ControlDescriptor } from '../../types.js';
import { waitForStability } from '../../browser/stability.js';
import { splitRange } from '../../testdata/provider.js';
import {
  closeOverlay,
  confirmOverlay,
  selectFirstOption,
} from '../overlay.js';
import {
  editableLocator,
  ensureInteractable,
  notFound,
  resolveSelector,
  reveal,
} from './resolve.js';
import { openControlOverlay } from './open-overlay.js';
import type { HandlerContext, HandlerResult } from './types.js';

/**
 * Handlers for controls that hold a value: text, dropdowns, dates, lookups,
 * multi-selects, toggles and file uploads.
 *
 * Buttons are not here — their kind cannot be known without clicking, so they
 * go through the probe in `./buttons.ts` instead.
 */

/**
 * Text and numeric inputs.
 *
 * These reveal no overlay, so the evidence is the field carrying its value —
 * the screenshot is taken after filling rather than before.
 */
export async function handleTextual(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  await reveal(ctx.page, selector);
  const target = await editableLocator(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, target);
  if (blocked) return blocked;

  let value = ctx.testData.valueFor(control) ?? 'TEST01';

  /*
   * A native <input type="number"> rejects fill() outright for anything that
   * isn't a valid number -- confirmed on a live capture where the generic
   * 'TEST01' fallback threw "Cannot type text into input[type=number]" on
   * every plain numeric field with no configured test value (Electric Bill,
   * Water Bill, Annual Forecast, ...). Checked structurally against the
   * resolved element's own HTML type, not by field name, so it applies to any
   * numeric field in any app.
   */
  const isNumberInput = await target
    .evaluate((el: Element) => (el as HTMLInputElement).type === 'number')
    .catch(() => false);
  if (isNumberInput && !/^-?\d+(\.\d+)?$/.test(value)) {
    value = '1';
  }

  await target
    .click({ timeout: ctx.budgets.controlTimeoutMs })
    .catch(() => undefined);
  await target.fill(value, { timeout: ctx.budgets.controlTimeoutMs });
  // Commit the value the way a user would, so dependent fields react.
  await ctx.page.keyboard.press('Tab').catch(() => undefined);
  await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);

  await ctx.capture();
  return { documented: true };
}

/** Chooses the first meaningful option of a native <select>. */
async function selectFirstNativeOption(loc: Locator): Promise<string | null> {
  const options = await loc
    .evaluate((el: Element) =>
      Array.from((el as HTMLSelectElement).options)
        .filter((o) => !o.disabled && o.value !== '')
        .map((o) => ({ value: o.value, label: o.label || o.textContent || '' })),
    )
    .catch(() => [] as { value: string; label: string }[]);

  const first = options[0];
  if (!first) return null;

  await loc.selectOption(first.value, { timeout: 5000 }).catch(() => undefined);
  return first.label.trim() || first.value;
}

/**
 * Dropdowns and combo boxes.
 *
 * Opens the list, photographs it expanded, then picks a valid option.
 */
export async function handleSelect(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) return blocked;

  const { opened, baseline, isNative } = await openControlOverlay(control, ctx, loc, selector);

  if (isNative) {
    const chosen = await selectFirstNativeOption(loc);
    await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
    await ctx.capture();
    return {
      documented: true,
      note: chosen
        ? `native select set to "${chosen}" (list is OS-rendered)`
        : 'native select had no selectable option',
    };
  }

  // The expanded list is the evidence.
  await ctx.capture();

  if (!opened) {
    return { documented: true, note: 'dropdown did not visibly open' };
  }

  const chosen = await selectFirstOption(ctx.page, ctx.budgets.controlTimeoutMs, baseline);
  await closeOverlay(ctx.page, undefined, baseline);
  await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);

  return {
    documented: true,
    ...(chosen ? { note: `selected "${chosen}"` } : {}),
  };
}

/**
 * Clicks a selectable day in an open UI5 calendar.
 *
 * Day cells carry `data-sap-day="YYYYMMDD"`; cells outside the displayed month
 * or otherwise unavailable are marked `aria-disabled`. Today's cell is
 * preferred when it is selectable, since a date the application already
 * considers current is the least likely to fail validation.
 *
 * Returns the chosen date, or null when no calendar day could be clicked.
 */
async function pickCalendarDay(page: Page): Promise<string | null> {
  const cells = page.locator(
    '.sapUiCalItem[data-sap-day]:not([aria-disabled="true"]):not(.sapUiCalItemOtherMonth)',
  );

  const count = await cells.count().catch(() => 0);
  if (count === 0) return null;

  const today = page
    .locator('.sapUiCalItemNow[data-sap-day]:not([aria-disabled="true"])')
    .first();
  const target = (await today.count().catch(() => 0)) > 0 ? today : cells.first();

  const day = await target.getAttribute('data-sap-day').catch(() => null);
  const clicked = await target
    .click({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  if (!clicked) return null;
  await page.waitForTimeout(250);
  return day;
}

/**
 * Date and date-range pickers.
 *
 * Opens the calendar and photographs it, then picks a day from it — falling
 * back to typing the value when there is no calendar to pick from.
 */
export async function handleDate(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) return blocked;

  const { opened, baseline, isNative } = await openControlOverlay(control, ctx, loc, selector);

  // The open calendar is the evidence.
  await ctx.capture();

  /*
   * Prefer picking a day from the open calendar, which is what a tester does
   * and what the reference documents show. It also sidesteps date-format
   * mismatches entirely — the field's own locale formatting is applied by the
   * control rather than guessed at by typing a string.
   */
  if (opened) {
    const picked = await pickCalendarDay(ctx.page);
    await closeOverlay(ctx.page, undefined, baseline);
    if (picked) {
      await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
      return { documented: true, note: `picked ${picked} from the calendar` };
    }
  }

  // No calendar to pick from: fall back to typing the value.
  const raw = ctx.testData.valueFor(control);
  if (raw) {
    const target = await editableLocator(ctx.page, selector);

    /*
     * A native `<input type="date">` (the `isNative` branch above already
     * routed here whenever one is found) does not accept `fill()`'s CDP
     * `Input.insertText`: that call simulates IME-style text insertion,
     * which a date input's segmented day/month/year widget silently
     * discards rather than parses -- confirmed on a live capture where the
     * value was empty in the final screenshot despite `fill()` resolving
     * without error. Assigning `.value` directly and dispatching the events
     * the input itself would fire is what actually reaches a native control,
     * exactly as the native-`<select>` branch above already does for the
     * same reason.
     */
    if (isNative) {
      const value = control.kind === 'dateRange' ? splitRange(raw)[0] : raw;
      await target
        .evaluate((el: Element, v: string) => {
          const input = el as HTMLInputElement;
          input.value = v;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, value)
        .catch(() => undefined);
    } else if (control.kind === 'dateRange') {
      const [from, to] = splitRange(raw);
      await target.fill(`${from} - ${to}`, { timeout: 5000 }).catch(() => undefined);
      await ctx.page.keyboard.press('Enter').catch(() => undefined);
    } else {
      await target.fill(raw, { timeout: 5000 }).catch(() => undefined);
      await ctx.page.keyboard.press('Enter').catch(() => undefined);
    }
  }

  await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
  return { documented: true };
}

/**
 * Value-help / lookup fields.
 *
 * These must not be typed into: the target system only accepts codes that exist.
 * The handler opens the lookup, photographs it, and selects a real row.
 */
export async function handleValueHelp(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) return blocked;

  const { opened, baseline } = await openControlOverlay(control, ctx, loc, selector);

  // The open lookup dialog is the evidence.
  await ctx.capture();

  if (!opened) {
    return { documented: true, note: 'value help did not open' };
  }

  /*
   * A lookup dialog carries its own interactive content -- filter fields, a
   * variant selector, its own dropdowns -- exactly as the generic reveal path
   * (probeButton) already explores. Each of those earns its own point, so the
   * dialog is documented as thoroughly as the page that opened it, rather
   * than as a single screenshot of its initial state. `baseline` keeps that
   * nested exploration scoped to the dialog this interaction just opened,
   * not any leftover overlay already on screen alongside it.
   */
  await ctx.exploreRevealed?.(baseline);

  const chosen = await selectFirstOption(ctx.page, ctx.budgets.controlTimeoutMs, baseline);
  if (chosen) await confirmOverlay(ctx.page, baseline);
  await closeOverlay(ctx.page, undefined, baseline);
  await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);

  return {
    documented: true,
    ...(chosen ? { note: `selected "${chosen}"` } : { note: 'no selectable row' }),
  };
}

/** Multi-select controls: open the list, photograph it, tick one entry. */
export async function handleMultiSelect(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) return blocked;

  const { opened, baseline } = await openControlOverlay(control, ctx, loc, selector);
  await ctx.capture();

  if (opened) {
    const chosen = await selectFirstOption(ctx.page, ctx.budgets.controlTimeoutMs, baseline);
    await closeOverlay(ctx.page, undefined, baseline);
    await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
    return { documented: true, ...(chosen ? { note: `selected "${chosen}"` } : {}) };
  }
  return { documented: true, note: 'multi-select did not visibly open' };
}

/** Checkboxes, switches and radio buttons: toggle, then photograph the result. */
export async function handleToggle(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  const loc = await reveal(ctx.page, selector);

  const blocked = await ensureInteractable(control, ctx, loc);
  if (blocked) return blocked;

  await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
  await waitForStability(ctx.page, ctx.budgets.stabilityTimeoutMs);
  await ctx.capture();
  return { documented: true };
}

/**
 * File upload controls.
 *
 * The control is photographed in place; no file is actually uploaded, since
 * uploading would attach real data to a real record.
 */
export async function handleFileUpload(
  control: ControlDescriptor,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const selector = await resolveSelector(ctx.page, control);
  if (!selector) return notFound(control);

  await reveal(ctx.page, selector);
  await ctx.capture();
  return { documented: true, note: 'upload control captured without uploading' };
}
