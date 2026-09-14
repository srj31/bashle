export class UnbalancedQuoteError extends Error {
  constructor(readonly quote: string) {
    super(`Unbalanced ${quote === '"' ? 'double' : 'single'} quote in probe arguments.`);
    this.name = 'UnbalancedQuoteError';
  }
}

const NEEDS_QUOTING = /[^A-Za-z0-9_@%+=:,./-]/;

export function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let started = false;
  let openQuote: '"' | "'" | null = null;

  const finishWord = () => {
    if (started) words.push(current);
    current = '';
    started = false;
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;

    if (openQuote === "'") {
      if (char === "'") openQuote = null;
      else current += char;
      continue;
    }

    if (openQuote === '"') {
      if (char === '\\' && i + 1 < input.length && /["\\$`]/.test(input[i + 1]!)) {
        current += input[++i];
      } else if (char === '"') {
        openQuote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '\\' && i + 1 < input.length) {
      current += input[++i];
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      openQuote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      finishWord();
      continue;
    }
    current += char;
    started = true;
  }

  if (openQuote) throw new UnbalancedQuoteError(openQuote);
  finishWord();
  return words;
}

export function quoteShellWord(word: string): string {
  if (word === '') return "''";
  if (!NEEDS_QUOTING.test(word)) return word;
  return `'${word.split("'").join(`'\\''`)}'`;
}
