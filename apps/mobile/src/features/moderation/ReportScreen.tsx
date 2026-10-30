import {
  countChars,
  REPORT_DETAILS_MAX_LENGTH,
  REPORT_REASON_LABELS,
  REPORT_REASONS,
  type ReportReason,
  type ReportTarget,
} from '@sussurro/shared';
import {
  EmptyState,
  Icon,
  Input,
  RadioOptionList,
  ScreenHeader,
  Text,
  theme,
  useToast,
} from '@sussurro/ui';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { type ReportRouteParams, reportTargetFrom } from './report-target';
import { isApiError } from '../../lib/api/errors';
import { messageForError } from '../../lib/error-messages';
import { useAuth } from '../auth/AuthProvider';
import { POST_UNAVAILABLE } from '../posts/PostDetailScreen';
import { createReport } from '../relations/api';
import { PROFILE_GONE_MESSAGE } from '../relations/useFollowToggle';

export const REPORT_SENT_MESSAGE = 'Denúncia enviada. Obrigado por avisar.';
export const REPORT_PRIVACY_NOTE = 'A pessoa denunciada não é avisada.';
export const REPORT_DETAILS_LABEL = 'Detalhes (opcional)';
export const COMMENT_GONE_MESSAGE = 'Este comentário não está mais disponível.';
export const REPORT_DETAILS_TOO_LONG = `Use no máximo ${String(REPORT_DETAILS_MAX_LENGTH)} caracteres.`;

const OPTIONS = REPORT_REASONS.map((reason) => ({
  key: reason,
  title: REPORT_REASON_LABELS[reason],
}));

function question(target: ReportTarget): string {
  switch (target.type) {
    case 'post':
      return 'Por que você está denunciando esta publicação?';
    case 'comment':
      return 'Por que você está denunciando este comentário?';
    case 'account':
      return `Por que você está denunciando @${target.handle}?`;
  }
}

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
 * Denunciar publicação, comentário ou conta (X.1): um dos 8 motivos (obrigatório), detalhes
 * opcionais até 500 caracteres com contador e "Enviar". Depois do 202, fecha com um Toast neutro;
 * a pessoa denunciada não é avisada. 404 (o conteúdo sumiu) fecha com o aviso; 429 e falha de rede
 * mantêm o formulário para tentar de novo.
 */
export function ReportScreen() {
  const params = useLocalSearchParams<Record<keyof ReportRouteParams, string>>();
  const target = reportTargetFrom(params);
  const { api } = useAuth();
  const toast = useToast();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);

  const tooLong = countChars(details) > REPORT_DETAILS_MAX_LENGTH;
  const canSend = target !== null && reason !== null && !tooLong && !sending;

  const send = () => {
    if (target === null || reason === null || !canSend) return;
    setSending(true);
    const trimmed = details.trim();
    createReport(api, { target, reason, ...(trimmed === '' ? {} : { details: trimmed }) })
      .then(() => {
        toast.show({ message: REPORT_SENT_MESSAGE, variant: 'success' });
        close();
      })
      .catch((error: unknown) => {
        setSending(false);
        if (isApiError(error, 'NOT_FOUND')) {
          toast.show({ message: goneMessage(target), variant: 'error' });
          close();
          return;
        }
        toast.show({ message: messageForError(error), variant: 'error' });
      });
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="tela-denunciar">
      <ScreenHeader
        variant="modal"
        title="Denunciar"
        left={{ label: 'Cancelar', onPress: close }}
        right={{ label: 'Enviar', primary: true, disabled: !canSend, onPress: send }}
      />
      {target === null ? (
        <EmptyState
          icon="circle-alert"
          title="Não foi possível abrir a denúncia"
          primaryAction={{ label: 'Fechar', onPress: close }}
        />
      ) : (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text variant="titleSm" accessibilityRole="header">
              {question(target)}
            </Text>
            <RadioOptionList
              legend="Motivo"
              options={OPTIONS}
              value={reason}
              onChange={setReason}
              testID="motivo"
            />
            <Input
              label={REPORT_DETAILS_LABEL}
              type="multiline"
              value={details}
              onChangeText={setDetails}
              maxLength={REPORT_DETAILS_MAX_LENGTH}
              showCounter
              countFn={countChars}
              {...(tooLong ? { error: REPORT_DETAILS_TOO_LONG } : {})}
              testID="detalhes"
            />
            <View style={styles.note}>
              <Icon name="lock" size={16} color="grey" />
              <Text variant="bodySm" color="grey" style={styles.flex}>
                {REPORT_PRIVACY_NOTE}
              </Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  flex: { flex: 1 },
  content: { padding: theme.layout.screenX, gap: theme.space[16] },
  note: { flexDirection: 'row', alignItems: 'center', gap: theme.space[8] },
});
