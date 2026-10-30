import { CommentsScreen } from '../../features/comments/CommentsScreen';
import { RequireSession } from '../../features/navigation/guards';

/** Folha de comentários (ux.md §4.3). */
export default function ComentariosRoute() {
  return (
    <RequireSession>
      <CommentsScreen />
    </RequireSession>
  );
}
