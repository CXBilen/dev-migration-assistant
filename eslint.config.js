// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.tsbuildinfo',
      'fixtures/**',
      '.remember/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='child_process'][callee.property.name='exec']",
          message:
            'Never use exec with interpolated strings. Use execFile/execa with an args array.',
        },
        {
          selector:
            "ImportDeclaration[source.value='child_process'] ImportSpecifier[imported.name='exec']",
          message:
            'Never use exec with interpolated strings. Use execFile/execa with an args array.',
        },
        {
          selector:
            "ImportDeclaration[source.value='node:child_process'] ImportSpecifier[imported.name='exec']",
          message:
            'Never use exec with interpolated strings. Use execFile/execa with an args array.',
        },
        {
          selector: "CallExpression[callee.name='eval']",
          message: 'eval is forbidden.',
        },
        {
          selector: "CallExpression[callee.name='execSync']",
          message: 'execSync runs a shell string. Use Exec(file, args[]) from @devmig/shared.',
        },
        {
          selector:
            "CallExpression[callee.object.name='child_process'][callee.property.name='execSync']",
          message: 'execSync runs a shell string. Use Exec(file, args[]) from @devmig/shared.',
        },
        {
          selector:
            "ImportDeclaration[source.value='child_process'] ImportSpecifier[imported.name='execSync']",
          message: 'execSync runs a shell string. Use Exec(file, args[]) from @devmig/shared.',
        },
        {
          selector:
            "ImportDeclaration[source.value='node:child_process'] ImportSpecifier[imported.name='execSync']",
          message: 'execSync runs a shell string. Use Exec(file, args[]) from @devmig/shared.',
        },
        {
          selector: "Property[key.name='shell'][value.value=true]",
          message:
            'shell: true re-introduces shell parsing of arguments. Subprocesses run with shell: false (packages/shared/src/exec.ts:50).',
        },
        {
          selector: "NewExpression[callee.name='Function']",
          message: 'new Function is dynamic code execution; it is forbidden like eval.',
        },
        {
          selector: "CallExpression[callee.name='Function']",
          message: 'Function() is dynamic code execution; it is forbidden like eval.',
        },
      ],
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
)
