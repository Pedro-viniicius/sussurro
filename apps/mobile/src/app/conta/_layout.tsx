import { Stack } from 'expo-router';

import { RequireSession } from '../../features/navigation/guards';

export default function ContaLayout() {
  return (
    <RequireSession>
      <Stack screenOptions={{ headerShown: false }} />
    </RequireSession>
  );
}
