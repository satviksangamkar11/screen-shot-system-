import type { Page } from '../automation/types.js';
import type { CDPSession } from '../automation/cdp-session.js';
import { log } from '../util/logger.js';
import { errMsg } from '../evidence/store.js';

/**
 * Streams a live view of one page to the operator and forwards their
 * clicks/keystrokes back into it, for Manual mode's in-page remote control.
 *
 * Built directly on Chrome DevTools Protocol's own screencast
 * (`Page.startScreencast` / `Page.screencastFrame`) for the outbound video,
 * and `page.mouse` / `page.keyboard` for inbound input — both implemented in
 * automation/page-shim.ts over the CDP transport in automation/cdp-*.ts.
 * `page.context().newCDPSession()` attaches a genuinely independent CDP
 * session to the same target (see CdpSession.attachNewSession), so this
 * class's own `detach()` only tears down its screencast subscription, never
 * the page's main session. The HTTP layer (server/app.ts) relays frames out
 * over Server-Sent Events and input in over plain POST bodies; this class
 * knows nothing about HTTP at all.
 *
 * One instance lives for a whole capture run (constructed once the page
 * exists — see capture.ts); `start`/`stop` just toggle the CDP screencast on
 * and off as `interaction/manual.ts` moves from one control to the next, so
 * an operator's browser can open a single subscription for the whole job and
 * simply see nothing between fields rather than needing to reconnect.
 */
export class RemoteControl {
  private session: CDPSession | undefined;
  private readonly listeners = new Set<(jpegBase64: string) => void>();
  private latestFrame: string | undefined;
  private passwordMaskStates: Array<{ selector: string; value: string }> | undefined;

  constructor(private readonly page: Page) {}

  /**
   * Subscribes to frames as they arrive; immediately replays the most recent
   * one, if any, so a subscriber that connects mid-stream isn't left blank.
   * Returns an unsubscribe function.
   */
  onFrame(listener: (jpegBase64: string) => void): () => void {
    this.listeners.add(listener);
    if (this.latestFrame) listener(this.latestFrame);
    return () => this.listeners.delete(listener);
  }

  /** Starts screencasting the current control's field into any subscribers. */
  async start(): Promise<void> {
    // Mask password fields before streaming to prevent exposure in live view
    await this.maskPasswordsInPage();

    let frameCount = 0;
    try {
      const session = await this.page.context().newCDPSession(this.page);
      this.session = session;

      session.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
        frameCount++;
        this.latestFrame = frame.data;
        for (const listener of this.listeners) listener(frame.data);
        session
          .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
          .catch((err) => log.debug(`  [remote] frame ack failed: ${errMsg(err)}`));
      });

      await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        maxWidth: 1600,
        maxHeight: 900,
      });
      log.debug(`  [remote] screencast started (subscribers=${this.listeners.size})`);

      /*
       * Chrome only emits a screencast frame on an actual repaint. If the page
       * has already settled when `start()` runs, Chrome won't emit a frame until
       * the operator triggers one via click/type, leaving the live view stale.
       * Force an immediate repaint so the operator sees current state by
       * evaluating a script that reads a layout property (forces reflow).
       */
      await session
        .send('Runtime.evaluate', { expression: 'document.documentElement.offsetHeight' })
        .catch(() => undefined);

      /*
       * Backup timeout: if Chrome still hasn't sent a frame after 2s, warn so
       * a stale UI is visible in the log instead of unexplained silence.
       */
      setTimeout(() => {
        if (this.session === session && frameCount === 0) {
          log.warn(
            '  [remote] no screencast frame arrived within 2s of starting -- ' +
              'the live view may stay blank until the next repaint',
          );
        }
      }, 2000);
    } catch (err) {
      log.warn(`  [remote] could not start screencast: ${errMsg(err)}`);
      this.session = undefined;
    }
  }

  /** Stops screencasting. Safe to call even if `start` was never called. */
  async stop(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.latestFrame = undefined;
    if (!session) return;
    await session.send('Page.stopScreencast').catch(() => undefined);
    await session.detach().catch(() => undefined);

    // Restore password fields after streaming stops
    await this.unmaskPasswordsInPage();
  }

  /** Forwards a click at the given coordinates, in the page's own viewport space. */
  async click(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y).catch(() => undefined);
  }

  /** Forwards a single named key (Enter, Tab, Escape, Backspace, arrows, ...). */
  async key(key: string): Promise<void> {
    await this.page.keyboard.press(key).catch(() => undefined);
  }

  /**
   * Inserts text directly, without simulating individual keystrokes — the
   * one call that handles arbitrary Unicode (this system's UI is Japanese)
   * correctly with no IME/composition handling needed on either side.
   */
  async insertText(text: string): Promise<void> {
    await this.page.keyboard.insertText(text).catch(() => undefined);
  }

  /**
   * Masks password fields in the page DOM so they don't appear in the live
   * screencast. Replaces actual password values with placeholder dots.
   */
  private async maskPasswordsInPage(): Promise<void> {
    try {
      this.passwordMaskStates = await this.page.evaluate(() => {
        const saved: Array<{ selector: string; value: string }> = [];

        // Mask native password inputs
        const passwordInputs = document.querySelectorAll('input[type="password"]');
        for (let i = 0; i < passwordInputs.length; i++) {
          const el = passwordInputs[i] as HTMLInputElement;
          if (el.value) {
            saved.push({ selector: `password-${i}`, value: el.value });
            el.value = '••••••••';
          }
        }

        // Mask UI5 password fields
        const ui5Passwords = document.querySelectorAll('[data-type="password"]');
        for (let i = 0; i < ui5Passwords.length; i++) {
          const el = ui5Passwords[i] as HTMLElement;
          const input = el.querySelector('input');
          if (input && input.value) {
            saved.push({ selector: `ui5-password-${i}`, value: input.value });
            input.value = '••••••••';
          }
        }

        return saved;
      });
    } catch {
      // Masking failure is non-fatal; continue without masking
    }
  }

  /**
   * Restores password field values after streaming stops.
   * Undoes the masking from maskPasswordsInPage().
   */
  private async unmaskPasswordsInPage(): Promise<void> {
    if (!this.passwordMaskStates || this.passwordMaskStates.length === 0) return;

    try {
      const saved = this.passwordMaskStates;
      this.passwordMaskStates = undefined;

      await this.page.evaluate((saved) => {
        for (const entry of saved) {
          let elements: HTMLInputElement[] = [];

          if (entry.selector.startsWith('password-')) {
            const index = parseInt(entry.selector.replace('password-', ''));
            const el = document.querySelectorAll('input[type="password"]')[index];
            if (el) elements.push(el as HTMLInputElement);
          } else if (entry.selector.startsWith('ui5-password-')) {
            const index = parseInt(entry.selector.replace('ui5-password-', ''));
            const container = document.querySelectorAll('[data-type="password"]')[index];
            if (container) {
              const input = container.querySelector('input');
              if (input) elements.push(input as HTMLInputElement);
            }
          }

          for (const el of elements) {
            el.value = entry.value;
          }
        }
      }, saved);
    } catch {
      // Unmasking failure is non-fatal
    }
  }
}
