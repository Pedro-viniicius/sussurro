import { isDevRoutesEnabled } from './dev-routes';

describe('isDevRoutesEnabled', () => {
  it('liberado em desenvolvimento (__DEV__)', () => {
    expect(isDevRoutesEnabled(true, undefined)).toBe(true);
  });

  it('CA10 (0.8): bloqueado em build sem __DEV__ e sem a variável', () => {
    expect(isDevRoutesEnabled(false, undefined)).toBe(false);
    expect(isDevRoutesEnabled(false, '')).toBe(false);
    expect(isDevRoutesEnabled(false, '0')).toBe(false);
    expect(isDevRoutesEnabled(false, 'true')).toBe(false);
  });

  it('liberado fora de dev só com EXPO_PUBLIC_DEV_TOOLS=1', () => {
    expect(isDevRoutesEnabled(false, '1')).toBe(true);
  });
});
