const security = require('eslint-plugin-security');
module.exports = [
  security.configs.recommended,
  {
    ignores: ['node_modules/**', 'logs/**'],
  },
];
