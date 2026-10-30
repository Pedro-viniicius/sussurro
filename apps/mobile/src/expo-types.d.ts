// Tipos globais do Expo/Metro (process.env, require). O expo-env.d.ts equivalente é gerado pelo
// `expo start` e não é versionado; este arquivo garante os tipos no typecheck local e no CI.
/// <reference types="expo/types" />

// Imagens importadas pelo Metro (o número é o id do asset).
declare module '*.png' {
  const asset: number;
  export default asset;
}
