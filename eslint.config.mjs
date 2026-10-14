import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.cjs',
      '**/*.mjs',
      // 约定：下划线前缀 = 会话级临时诊断脚本，不进构建、不进 lint（如 _tidydiag*.ts）
      '**/_*.ts',
      '**/_*.tsx',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.ts', 'packages/**/*.tsx'],
    rules: {
      // v2 工程红线（G2）：零 any 新增、未用变量零容忍
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['packages/server/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'CallExpression[callee.type="MemberExpression"][callee.property.name=/^(get|post|put|patch|delete|all|use)$/] > ArrowFunctionExpression[async=true]',
        message: 'Express 4 async HTTP callbacks must use asyncHandler.',
      }, {
        selector: 'CallExpression[callee.type="MemberExpression"][callee.property.name=/^(get|post|put|patch|delete|all|use)$/] > FunctionExpression[async=true]',
        message: 'Express 4 async HTTP callbacks must use asyncHandler.',
      }],
    },
  },
);
