import { describe, expect, it } from 'vitest';
import { chipStatuses, defaultStatusSel, isDefaultStatusSel, statusSelForDeepLink } from './default-view';

describe('the Analytics opening view', () => {
  it('starts on Active only', () => {
    expect([...defaultStatusSel()]).toEqual(['ACTIVE']);
  });

  it('knows whether the selection is still the opening one', () => {
    expect(isDefaultStatusSel(new Set(['ACTIVE']))).toBe(true);
    expect(isDefaultStatusSel(new Set())).toBe(false); // "show all" is a change
    expect(isDefaultStatusSel(new Set(['ACTIVE', 'PAUSED']))).toBe(false);
    expect(isDefaultStatusSel(new Set(['PAUSED']))).toBe(false);
  });

  it('hands out a fresh set each time, so one edit cannot change the default', () => {
    const a = defaultStatusSel();
    a.add('PAUSED');
    expect([...defaultStatusSel()]).toEqual(['ACTIVE']);
  });
});

describe('chipStatuses', () => {
  it('lists the statuses in the data, sorted', () => {
    expect(chipStatuses(['PAUSED', 'ACTIVE', 'DRAFT', 'ACTIVE'], new Set(['ACTIVE']))).toEqual(['ACTIVE', 'DRAFT', 'PAUSED']);
  });
  it('still shows the selected status when nothing in the range has it', () => {
    expect(chipStatuses(['DRAFT', 'PAUSED'], new Set(['ACTIVE']))).toEqual(['ACTIVE', 'DRAFT', 'PAUSED']);
    expect(chipStatuses([], new Set(['ACTIVE']))).toEqual(['ACTIVE']);
  });
  it('is empty with no data and no selection', () => {
    expect(chipStatuses([], new Set())).toEqual([]);
  });
});

describe('statusSelForDeepLink', () => {
  it('keeps the filter when the linked campaign passes it', () => {
    expect([...statusSelForDeepLink(new Set(['ACTIVE']), 'ACTIVE')]).toEqual(['ACTIVE']);
  });
  it('drops the filter when it would hide the linked campaign', () => {
    expect(statusSelForDeepLink(new Set(['ACTIVE']), 'PAUSED').size).toBe(0);
    expect(statusSelForDeepLink(new Set(['ACTIVE']), 'ARCHIVED').size).toBe(0);
  });
  it('leaves "show all" alone', () => {
    expect(statusSelForDeepLink(new Set(), 'DRAFT').size).toBe(0);
  });
});
