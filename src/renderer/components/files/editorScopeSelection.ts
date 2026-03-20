import type * as monaco from 'monaco-editor';

/** Configuration for which scope types to enable. */
export interface ScopeSelectionConfig {
  /** Recognize bracket scopes: () [] {} — default: true */
  brackets: boolean;
  /** Recognize quote scopes: "" '' `` — default: true */
  quotes: boolean;
  /** Recognize indentation scopes (Python / YAML / Makefile) — default: true */
  indentation: boolean;
}

export const DEFAULT_SCOPE_CONFIG: ScopeSelectionConfig = {
  brackets: true,
  quotes: true,
  indentation: true,
};

interface OffsetRange {
  start: number; // inclusive — first char after the opening boundary
  end: number; // exclusive — points to the closing boundary char
}

const INDENT_RE = /^[ \t]*/;

/**
 * Find the innermost bracket scope ( () [] {} ) containing cursorOffset.
 * Handles nested brackets via a nesting counter.
 * If the bracket is unclosed, selects from the opening bracket to end of line.
 */
function findBracketScope(
  text: string,
  cursorOffset: number,
  openChar: string,
  closeChar: string
): OffsetRange | null {
  // Scan backward for the nearest unmatched opening bracket
  let nesting = 0;
  let openPos = -1;
  for (let i = cursorOffset - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === closeChar) {
      nesting++;
    } else if (ch === openChar) {
      if (nesting === 0) {
        openPos = i;
        break;
      }
      nesting--;
    }
  }
  if (openPos === -1) return null;

  // Scan forward from the opening bracket for its matching closing bracket
  nesting = 0;
  let closePos = -1;
  for (let i = openPos + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === openChar) {
      nesting++;
    } else if (ch === closeChar) {
      if (nesting === 0) {
        closePos = i;
        break;
      }
      nesting--;
    }
  }

  if (closePos === -1) {
    // Unclosed bracket: graceful degradation — select to end of line
    const lineEnd = text.indexOf('\n', openPos + 1);
    return { start: openPos + 1, end: lineEnd === -1 ? text.length : lineEnd };
  }

  return { start: openPos + 1, end: closePos };
}

/** Count consecutive backslashes immediately before position i. */
function countBackslashes(text: string, i: number): number {
  let count = 0;
  let j = i - 1;
  while (j >= 0 && text[j] === '\\') {
    count++;
    j--;
  }
  return count;
}

/**
 * Find the innermost quote scope ( "" '' `` ) containing cursorOffset.
 * Correctly handles escaped quotes (e.g. \" inside a double-quoted string).
 * Template literals (backticks) are allowed to span multiple lines.
 */
function findQuoteScope(text: string, cursorOffset: number, quoteChar: string): OffsetRange | null {
  const isTemplateLiteral = quoteChar === '`';

  // Scan backward for the nearest unescaped opening quote
  let openPos = -1;
  for (let i = cursorOffset - 1; i >= 0; i--) {
    if (!isTemplateLiteral && text[i] === '\n') break;
    if (text[i] === quoteChar && countBackslashes(text, i) % 2 === 0) {
      openPos = i;
      break;
    }
  }
  if (openPos === -1) return null;

  // Scan forward from the opening quote for the unescaped closing quote
  let closePos = -1;
  for (let i = openPos + 1; i < text.length; i++) {
    if (!isTemplateLiteral && text[i] === '\n') break;
    if (text[i] === quoteChar && countBackslashes(text, i) % 2 === 0) {
      closePos = i;
      break;
    }
  }
  if (closePos === -1) return null;

  // Verify the cursor is actually inside this quote pair
  if (cursorOffset < openPos + 1 || cursorOffset > closePos) return null;

  return { start: openPos + 1, end: closePos };
}

/**
 * Find the indentation scope containing the cursor.
 * Only activates for indentation-significant languages (Python, YAML, Makefile).
 * Selects all consecutive lines at the same or greater indentation level.
 */
function findIndentScope(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition
): OffsetRange | null {
  const lang = model.getLanguageId();
  if (!['python', 'yaml', 'makefile'].includes(lang)) return null;

  const { lineNumber } = position;
  const totalLines = model.getLineCount();
  const currentLine = model.getLineContent(lineNumber);
  const currentIndent = INDENT_RE.exec(currentLine)?.[0].length ?? 0;

  if (currentIndent === 0) return null; // Top-level code has no enclosing indent scope

  // Walk upward to find the first line of this indented block
  let startLine = lineNumber;
  for (let i = lineNumber - 1; i >= 1; i--) {
    const line = model.getLineContent(i);
    if (line.trim() === '') continue; // Skip blank lines
    const indent = INDENT_RE.exec(line)?.[0].length ?? 0;
    if (indent < currentIndent) break;
    startLine = i;
  }

  // Walk downward to find the last line of this indented block
  let endLine = lineNumber;
  for (let i = lineNumber + 1; i <= totalLines; i++) {
    const line = model.getLineContent(i);
    if (line.trim() === '') continue;
    const indent = INDENT_RE.exec(line)?.[0].length ?? 0;
    if (indent < currentIndent) break;
    endLine = i;
  }

  if (startLine === endLine) return null; // Single line is not a meaningful scope

  const start = model.getOffsetAt({ lineNumber: startLine, column: currentIndent + 1 });
  const end = model.getOffsetAt({ lineNumber: endLine, column: model.getLineLength(endLine) + 1 });

  return { start, end };
}

/**
 * Compute the innermost scope selection range for a double-click at position.
 *
 * Priority order:
 * 1. Smallest bracket or quote scope enclosing the cursor
 * 2. Indentation scope (only when no bracket/quote scope found, language-specific)
 * 3. null → caller should fall back to Monaco's default word selection
 *
 * The returned range excludes the boundary characters (brackets/quotes).
 */
export function computeScopeSelection(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  config: ScopeSelectionConfig = DEFAULT_SCOPE_CONFIG
): monaco.IRange | null {
  const text = model.getValue();
  const cursorOffset = model.getOffsetAt(position);

  // If the cursor lands on a word character, let Monaco handle its native word
  // selection instead of expanding to the enclosing scope.
  if (/\w/.test(text[cursorOffset] ?? '')) return null;

  const candidates: OffsetRange[] = [];

  if (config.brackets) {
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ]) {
      const scope = findBracketScope(text, cursorOffset, open, close);
      if (scope) candidates.push(scope);
    }
  }

  if (config.quotes) {
    for (const quote of ['"', "'", '`']) {
      const scope = findQuoteScope(text, cursorOffset, quote);
      if (scope) candidates.push(scope);
    }
  }

  // Only fall back to indentation scope when no bracket/quote scope applies
  if (candidates.length === 0 && config.indentation) {
    const scope = findIndentScope(model, position);
    if (scope) candidates.push(scope);
  }

  if (candidates.length === 0) return null;

  // Select the smallest (innermost) enclosing scope
  const best = candidates.reduce((a, b) => (b.end - b.start < a.end - a.start ? b : a));

  const start = model.getPositionAt(best.start);
  const end = model.getPositionAt(best.end);

  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  };
}

/**
 * Register a double-click handler on a Monaco editor that selects the innermost
 * scope containing the cursor instead of Monaco's default word selection.
 * Falls back to Monaco's default behavior when no scope is detected.
 *
 * @returns A disposable — call `.dispose()` to remove the handler.
 */
export function setupDoubleClickScope(
  editor: monaco.editor.IStandaloneCodeEditor,
  config: ScopeSelectionConfig = DEFAULT_SCOPE_CONFIG
): monaco.IDisposable {
  return editor.onMouseDown((e) => {
    if (e.event.detail !== 2) return;
    const position = e.target.position;
    if (!position) return;
    const model = editor.getModel();
    if (!model) return;

    // Wait for Monaco's own double-click handler to fire first, then override
    // the selection with our scope selection if a scope is found.
    setTimeout(() => {
      // Guard: model may have changed if user switched tabs before callback fired.
      if (editor.getModel() !== model) return;
      const range = computeScopeSelection(model, position, config);
      if (range) {
        editor.setSelection(range);
      }
    }, 0);
  });
}
