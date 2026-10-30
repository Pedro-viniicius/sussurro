import { ReportScreen } from '../features/moderation/ReportScreen';
import { RequireSession } from '../features/navigation/guards';

/** Modal "Denunciar" (X.1): publicação, comentário ou conta, com o alvo na query. */
export default function DenunciarRoute() {
  return (
    <RequireSession>
      <ReportScreen />
    </RequireSession>
  );
}
