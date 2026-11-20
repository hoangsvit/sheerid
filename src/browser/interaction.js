import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Random integer
const sample = range =>
  randomInt(range.min, range.max + 1);

// Validate delay ranges
function validateRange(name, range) {
  if (
    !range ||
    !Number.isSafeInteger(range.min) ||
    !Number.isSafeInteger(range.max) ||
    range.min < 0 ||
    range.max < range.min
  ) {
    throw new TypeError(`Invalid delay range: ${name}`);
  }
}

export function createInteraction(
  config,
  { signal, log = () => {} } = {}
) {
  // Validate configuration
  for (const key of [
    'fieldDelayMs',
    'submitDelayMs',
    'keyDelayMs',
  ]) {
    validateRange(key, config[key]);
  }

  // Check cancellation
  const checkAbort = () => {
    signal?.throwIfAborted();
  };

  // Shared randomized wait
  const pause = async (range, stage, field) => {
    checkAbort();

    const durationMs = sample(range);

    log('interaction_delay', {
      stage,
      field,
      durationMs,
    });

    if (durationMs > 0) {
      await delay(durationMs, undefined, { signal });
    }
  };

  return {

    // Wait before field actions
    beforeField: field =>
      pause(config.fieldDelayMs, 'fill', field),

    // Wait before dropdown actions
    beforeOption: field =>
      pause(config.fieldDelayMs, 'select_option', field),

    // Wait before submitting
    beforeSubmit: () =>
      pause(config.submitDelayMs, 'submit', 'submit'),

    // Keyboard input with randomized delays
    async typeText(locator, value, options = {}) {
      const {
        field = 'input',
        clear = true,
        clearMode = 'fill',
      } = options;

      checkAbort();

      // Focus only; repeated clicking can close an already-open dropdown.
      await locator.focus();

      // Clear via fill by default to avoid keyboard shortcuts changing dropdown state.
      if (clear) {
        if (clearMode === 'keyboard') {
          await locator.press('ControlOrMeta+A');
          await locator.press('Backspace');
        } else if (clearMode === 'fill') {
          await locator.fill('');
        } else {
          throw new TypeError(`Invalid clearMode: ${clearMode}`);
        }
      }

      // Iterate over Unicode characters
      const characters = Array.from(
        String(value ?? '').replace(/\r\n?/g, '\n')
      );

      for (let i = 0; i < characters.length; i++) {
        checkAbort();

        const character = characters[i];

        // Type the current character
        if (character === '\n') {
          await locator.press('Enter');
        } else {
          await locator.pressSequentially(character);
        }

        // Randomized wait between characters
        if (i < characters.length - 1) {
          await pause(
            config.keyDelayMs,
            'type',
            field
          );
        }
      }

      log('interaction_typed', {
        field,
        characterCount: characters.length,
      });
    },
  };
}
