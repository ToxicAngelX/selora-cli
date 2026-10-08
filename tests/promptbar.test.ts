import { describe, expect, it } from 'vitest';
import { PromptBuffer, normalizePromptPaste, wrapPromptValue } from '../src/ui/promptbar.js';

describe('PromptBuffer', () => {
  it('supports cursor editing and multiline paste without submission', () => {
    const p = new PromptBuffer('hello');
    p.moveHome();
    p.insert('say ');
    p.moveEnd();
    p.insert('\nworld');
    expect(p.state()).toEqual({ value: 'say hello\nworld', cursor: 15 });
    expect(p.submit()).toBe('say hello\nworld');
    expect(p.state()).toEqual({ value: '', cursor: 0 });
  });

  it('normalizes bracketed paste newlines and strips terminal controls', () => {
    const esc = String.fromCharCode(27);
    expect(normalizePromptPaste(`a\r\nb${esc}[2J`)).toBe('a\nb');
  });

  it('wraps wide text by terminal cells', () => {
    expect(wrapPromptValue('界界a', 4)).toEqual(['界界', 'a']);
    expect(wrapPromptValue('one\ntwo', 20)).toEqual(['one', 'two']);
  });
});
