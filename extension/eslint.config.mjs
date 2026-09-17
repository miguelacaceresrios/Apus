// ESLint con reglas que usan los tipos: en una extensión, una promesa que nadie
// espera es un error que se pierde sin avisar. El formato lo decide Prettier.

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'out/', 'coverage/', 'node_modules/', '.vscode-test/', 'scripts/', '*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Las promesas se esperan o se descartan a propósito con `void`.
      '@typescript-eslint/no-floating-promises': 'error',
      // Los manejadores de eventos de VS Code pueden ser async: VS Code no espera su resultado, y eso está bien.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      curly: 'error',
    },
  },
  {
    files: ['test/unit/**'],
    rules: {
      // node:test registra cada test() sin que haga falta esperarlo, y un test puede ser async sin await.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  prettier,
);
