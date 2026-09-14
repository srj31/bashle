import { describe, it, expect } from 'vitest';
import { splitShellWords, quoteShellWord, UnbalancedQuoteError } from '../src/shellWords';

describe('splitShellWords', () => {
  it('splits on whitespace', () => {
    expect(splitShellWords('staging --dry-run')).toEqual(['staging', '--dry-run']);
  });

  it('keeps double-quoted runs together', () => {
    expect(splitShellWords('"my report.txt" out')).toEqual(['my report.txt', 'out']);
  });

  it('keeps single-quoted runs together', () => {
    expect(splitShellWords("'a b' c")).toEqual(['a b', 'c']);
  });

  it('joins adjacent quoted and bare fragments into one word', () => {
    expect(splitShellWords('a"b"c')).toEqual(['abc']);
  });

  it('honours backslash escapes outside quotes', () => {
    expect(splitShellWords('a\\ b')).toEqual(['a b']);
  });

  it('honours escaped quotes inside double quotes', () => {
    expect(splitShellWords('"a\\"b"')).toEqual(['a"b']);
  });

  it('treats a backslash inside single quotes literally', () => {
    expect(splitShellWords("'a\\b'")).toEqual(['a\\b']);
  });

  it('returns nothing for empty or whitespace-only input', () => {
    expect(splitShellWords('')).toEqual([]);
    expect(splitShellWords('   ')).toEqual([]);
  });

  it('preserves an empty quoted word', () => {
    expect(splitShellWords('a "" b')).toEqual(['a', '', 'b']);
  });

  it('rejects an unbalanced quote rather than guessing', () => {
    expect(() => splitShellWords('"unterminated')).toThrow(UnbalancedQuoteError);
  });
});

describe('quoteShellWord', () => {
  it('leaves a safe word alone', () => {
    expect(quoteShellWord('simple')).toBe('simple');
  });

  it('single-quotes anything with whitespace', () => {
    expect(quoteShellWord('a b')).toBe("'a b'");
  });

  it('neutralises an embedded single quote', () => {
    expect(quoteShellWord("it's")).toBe(`'it'\\''s'`);
  });

  it('quotes characters the shell would otherwise act on', () => {
    for (const dangerous of ['$(whoami)', '`id`', 'a;b', 'a|b', '*', '$HOME']) {
      const quoted = quoteShellWord(dangerous);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
    }
  });
});
