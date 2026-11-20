import type { ReportTarget } from '@sussurro/shared';
import { EmptyState, ScreenHeader, theme, useToast } from '@sussurro/ui';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { type ReportRouteParams, reportTargetFrom } from './report-target';
import { REPORT_SENT_MESSAGE, ReportForm } from './ReportForm';
import { POST_UNAVAILABLE } from '../posts/PostDetailScreen';
import { PROFILE_GONE_MESSAGE } from '../relations/useFollowToggle';

export {
  REPORT_DETAILS_LABEL,
  REPORT_DETAILS_TOO_LONG,
  REPORT_PRIVACY_NOTE,
  REPORT_SENT_MESSAGE,
} from './ReportForm';

export const COMMENT_GONE_MESSAGE = 'Este comentário não está mais disponível.';

/** O conteúdo sumiu (apagado, bloqueio, sem acesso): a API responde o mesmo 404. */
function goneMessage(target: ReportTarget): string {
  switch (target.type) {
    case 'post':
      return POST_UNAVAILABLE;
    case 'comment':
      return COMMENT_GONE_MESSAGE;
    case 'account':
      return PROFILE_GONE_MESSAGE;
  }
}

function close() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/**
 * Denunciar publicação, comentário ou conta (X.1), na rota `/denunciar`: o formulário de sempre
 * (`ReportForm`). Depois do 202, fecha com um Toast neutro; a pessoa denunciada não é avisada. 404
 * (o conteúdo sumiu) fecha com o aviso; 429, 503 e falha de rede mantêm o formulário para tentar de
 * novo, com o erro na linha do próprio formulário: a rota abre como modal nativo
 * (`presentation: 'modal'`), e no iOS o Toast da raiz ficaria atrás dele (ux.md §11.18). Os
 * avisos do 202 e do 404 continuam no Toast, porque a rota fecha junto e eles ficam à vista.
 */
export function ReportScreen() {
  const params = useLocalSearchParams<Record<keyof ReportRouteParams, string>>();
  const target = reportTargetFrom(params);
  const toast = useToast();

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="tela-denunciar">
      {target === null ? (
        <>
          <ScreenHeader
            variant="modal"
            title="Denunciar"
            left={{ label: 'Cancelar', onPress: close }}
            right={{ label: 'Enviar', primary: true, disabled: true, onPress: () => undefined }}
          />
          <EmptyState
            icon="circle-alert"
            title="Não foi possível abrir a denúncia"
            primaryAction={{ label: 'Fechar', onPress: close }}
          />
        </>
      ) : (
        <ReportForm
          target={target}
          errorTestID="denunciar-erro"
          onClose={close}
          onSent={() => {
            toast.show({ message: REPORT_SENT_MESSAGE, variant: 'success' });
            close();
          }}
          onGone={() => {
            toast.show({ message: goneMessage(target), variant: 'error' });
            close();
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
});
