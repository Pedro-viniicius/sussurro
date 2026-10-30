import { CreateScreen } from '../features/create/CreateScreen';
import { RequireSession } from '../features/navigation/guards';

/** Modal "Nova publicação" (fullScreenModal, sem tab bar): FOTO e TEXTO; REEL na Fase 5. */
export default function CriarRoute() {
  return (
    <RequireSession>
      <CreateScreen />
    </RequireSession>
  );
}
