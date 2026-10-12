// Lint with type information (typescript-eslint's recommended-type-checked + stylistic-type-checked).
// The existing code has a backlog of findings, so every rule reports as a warning for now and only
// the rules the code already passes fail the build. Raise a rule to "error" once its backlog is
// cleared, so it cannot come back.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** rules already at zero findings: these fail the build */
const ENFORCED = {
  '@typescript-eslint/no-floating-promises': 'error',
  // a described @ts-ignore is allowed only where an untyped .mjs test helper is imported
  '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': 'allow-with-description' }],
  '@typescript-eslint/switch-exhaustiveness-check': ['warn', { considerDefaultExhaustiveForUnions: true }],
  'no-var': 'error',
};

/** every rule a preset turns on, reported as a warning */
const asWarnings = configs => configs.map(c => (c.rules
  ? { ...c, rules: Object.fromEntries(Object.entries(c.rules).map(([k, v]) => [k, v === 'off' || v === 0 || (Array.isArray(v) && (v[0] === 'off' || v[0] === 0)) ? v : Array.isArray(v) ? ['warn', ...v.slice(1)] : 'warn'])) }
  : c));

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'out/**', '.vscode-test/**', 'public/**', 'notepad++/**', '**/*.js', '**/*.mjs'] },
  ...asWarnings([js.configs.recommended, ...tseslint.configs.recommendedTypeChecked, ...tseslint.configs.stylisticTypeChecked]),
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: ENFORCED,
  },
);
