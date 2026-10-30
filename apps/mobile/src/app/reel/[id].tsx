import { RequireSession } from '../../features/navigation/guards';
import { ReelViewerScreen } from '../../features/reels/ReelViewerScreen';

/** Visualizador de reels (ux.md §4.4): `fullScreenModal` preto, fora das abas. */
export default function ReelRoute() {
  return (
    <RequireSession>
      <ReelViewerScreen />
    </RequireSession>
  );
}
