import { describe, it, expect } from 'vitest';
import { buildReopenOptions, REOPEN_SOURCE_TYPES } from './reopenOptions';

describe('buildReopenOptions', () => {
  it('returns the built-in types unchanged when sourceType is one of them', () => {
    const options = buildReopenOptions('Logcat');
    expect(options).toEqual(REOPEN_SOURCE_TYPES.map((t) => ({ value: t, label: t })));
    expect(options.every((o) => o.disabled === undefined)).toBe(true);
  });

  it('prepends a disabled placeholder for a custom-parser source type', () => {
    const options = buildReopenOptions('Custom(my_parser)');
    expect(options[0]).toEqual({ value: 'Custom(my_parser)', label: 'Custom(my_parser)', disabled: true });
    expect(options).toHaveLength(REOPEN_SOURCE_TYPES.length + 1);
    // The rest of the list is still every built-in reopen target, untouched.
    expect(options.slice(1)).toEqual(REOPEN_SOURCE_TYPES.map((t) => ({ value: t, label: t })));
  });

  it('prepends a placeholder for any other unrecognized label', () => {
    const options = buildReopenOptions('Unknown');
    expect(options[0]).toEqual({ value: 'Unknown', label: 'Unknown', disabled: true });
  });

  it('returns just the built-ins when sourceType is undefined', () => {
    expect(buildReopenOptions(undefined)).toEqual(REOPEN_SOURCE_TYPES.map((t) => ({ value: t, label: t })));
  });

  it('returns just the built-ins when sourceType is null', () => {
    expect(buildReopenOptions(null)).toEqual(REOPEN_SOURCE_TYPES.map((t) => ({ value: t, label: t })));
  });

  it('returns just the built-ins when sourceType is an empty string', () => {
    expect(buildReopenOptions('')).toEqual(REOPEN_SOURCE_TYPES.map((t) => ({ value: t, label: t })));
  });

  it('the placeholder value always matches a real <option> so a controlled select never renders blank', () => {
    for (const custom of ['Custom(a)', 'Custom(weird id with spaces)', 'Unknown', 'SomethingElse']) {
      const options = buildReopenOptions(custom);
      expect(options.some((o) => o.value === custom)).toBe(true);
    }
  });
});
