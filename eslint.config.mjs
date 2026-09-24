import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.mjs',
      '**/*.cjs',
      '**/*.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Raw driver access bypasses the tenant plugin. Use models only.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[property.name='collection'][object.type='Identifier'][object.name=/Model$/]",
          message: 'Raw collection access bypasses tenant isolation. Use the model API.',
        },
      ],
    },
  },
);
