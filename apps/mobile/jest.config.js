/**
 * Jest + jest-expo para o app (testes.md §2), igual ao de packages/ui. O padrão do jest-expo não conhece o
 * layout do pnpm (node_modules/.pnpm/...): a lista abaixo transforma o que vem de lá e só
 * ignora o que não é React Native.
 */
const path = require('node:path');

// Barras normais: o Jest no Windows não acha o caminho mapeado com barras invertidas.
const lucideCjs = require.resolve('lucide-react-native').replaceAll(path.sep, '/');

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // O CI começa sem o cache de transformação do Babel: o 1º teste de uma suíte pesada pode passar
  // dos 5 s padrão só compilando os módulos do React Native (aconteceu no CommentsSheet).
  testTimeout: 20_000,
  // O jest-expo resolve a condição "react-native" do Lucide (ESM .mjs, que o babel-jest não
  // transforma): aponta o pacote e os ícones avulsos para o build CommonJS.
  moduleNameMapper: {
    '^lucide-react-native$': lucideCjs,
    '^lucide-react-native/icons/(.*)$': `${path.posix.dirname(lucideCjs)}/icons/$1.js`,
  },
  testMatch: ['<rootDir>/src/**/*.test.ts?(x)', '<rootDir>/modules/**/*.test.ts?(x)'],
  transformIgnorePatterns: [
    'node_modules/(?!(\\.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-svg|lucide-react-native|standard-navigation))',
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    'modules/*/src/**/*.ts',
    '!src/**/*.test.{ts,tsx}',
    '!modules/**/*.test.ts',
  ],
  coverageReporters: ['text', 'lcov'],
};
