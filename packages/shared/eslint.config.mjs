import { nodeConfig } from '@sussurro/config/eslint/node';

export default nodeConfig({ tsconfigRootDir: import.meta.dirname, restrictReactAndNest: true });
