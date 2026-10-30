import { RequireSession } from '../features/navigation/guards';
import { EditarPerfilScreen } from '../features/profile/EditarPerfilScreen';

export default function EditarPerfilRoute() {
  return (
    <RequireSession>
      <EditarPerfilScreen />
    </RequireSession>
  );
}
