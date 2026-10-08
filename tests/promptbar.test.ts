import { describe, expect, it } from 'vitest';
import { PromptBuffer, layoutPromptValue, normalizePromptPaste, wrapPromptValue } from '../src/ui/promptbar.js';

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

  it('normalizes CRLF and lone CR before stripping controls', () => {
    expect(normalizePromptPaste('a\r\nb\rc\x1b[2J\x1b]0;evil\x07')).toBe('a\nb\nc');
  });

  it.each(['😀', 'é', '👨‍👩‍👧‍👦', '🇬🇧'])('edits %s as a whole grapheme', (glyph) => {
    const p = new PromptBuffer(`a${glyph}z`);
    p.moveLeft();
    p.backspace();
    expect(p.state()).toEqual({ value: 'az', cursor: 1 });
    p.insert(glyph);
    p.moveLeft();
    expect(p.state().cursor).toBe(1);
    p.deleteForward();
    expect(p.state().value).toBe('az');
    p.setValue(`a${glyph}z`, 2);
    expect(p.state().cursor).toBe(1);
  });

  it('uses logical home/end and cell-based vertical motion', () => {
    const p = new PromptBuffer('abcd\n界x\nabcdef');
    p.moveVertical(-1);
    expect(p.state().cursor).toBe(7);
    p.moveVertical(-1);
    expect(p.state().cursor).toBe(4);
    expect(p.moveVertical(-1)).toBe(false);
    p.moveHome();
    expect(p.state().cursor).toBe(0);
    p.moveVertical(1);
    expect(p.state().cursor).toBe(5);
    p.moveEnd();
    expect(p.state().cursor).toBe(7);
  });

  it('moves and deletes words without splitting Unicode', () => {
    const p = new PromptBuffer('one 界界 👨‍👩‍👧‍👦');
    p.deleteWordBackward();
    expect(p.state().value).toBe('one 界界 ');
    p.moveWordLeft();
    expect(p.state().cursor).toBe(4);
    p.deleteWordForward();
    expect(p.state().value).toBe('one  ');
  });

  it('wraps wide text and whole emoji by terminal cells', () => {
    expect(wrapPromptValue('界界a', 4)).toEqual(['界界', 'a']);
    expect(wrapPromptValue('é👨‍👩‍👧‍👦z', 2)).toEqual(['é', '👨‍👩‍👧‍👦', 'z']);
    expect(wrapPromptValue('one\ntwo', 20)).toEqual(['one', 'two']);
    expect(layoutPromptValue('abcdef', 3, 3)).toEqual({ lines: ['abc', 'def'], cursor: { row: 1, col: 0 } });
    expect(layoutPromptValue('a\tb', 4).lines).toEqual(['a   ', 'b']);
  });
});
