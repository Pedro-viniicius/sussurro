// Padrão do Expo (ADR 0001): desde o SDK 55 o Metro se configura sozinho em monorepo, e os pacotes
// internos são lidos pela condição de export "react-native". O `getSentryExpoConfig` só envolve o
// `getDefaultConfig` do Expo para pôr o Debug ID no bundle e nos source maps (6.7 CA3, infra.md §7).
// Sem o replay da web nem o arquivo `sentry.options.json`: o app configura o Sentry no código.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

module.exports = getSentryExpoConfig(__dirname, { includeWebReplay: false, optionsFile: false });
