import { Stack } from 'expo-router';

import { RequireSignedOut } from '../../features/navigation/guards';

export default function AuthLayout() {
  return (
    <RequireSignedOut>
      <Stack screenOptions={{ headerShown: false }} />
    </RequireSignedOut>
  );
}
