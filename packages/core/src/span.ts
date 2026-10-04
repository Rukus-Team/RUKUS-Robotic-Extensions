/** A single-line text range: 0-based line, start column and length. Shared by every language parser. */
export interface Span { line: number; col: number; len: number }
