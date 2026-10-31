import {
  countChars,
  REPORT_DETAILS_MAX_LENGTH,
  REPORT_REASON_LABELS,
  REPORT_REASONS,
  type ReportReason,
  type ReportTarget,
} from '@sussurro/shared';
import { Icon, Input, RadioOptionList, ScreenHeader, Text, theme, useToast } from '@sussurro/ui';
import { type Ref, useState } from 'react';
import {
  AccessibilityInfo,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type ViewInstance,
} from 'react-native';

import { isApiError } from '../../lib/api/errors';
import { messageForError } from '../../lib/error-messages';
import { useAuth } from '../auth/AuthProvider';
import { createReport } from '../relations/api';

export const REPORT_SENT_MESSAGE = 'Denúncia enviada. Obrigado por avisar.';
export const REPORT_PRIVACY_NOTE = 'A pessoa denunciada não é avisada.';
export const REPORT_DETAILS_LABEL = 'Detalhes (opcional)';
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

export interface ReportFormProps {
  target: ReportTarget;
  /** "Cancelar" (e o "voltar" do Android, por quem abriu): fecha sem enviar; o texto se perde. */
  onClose: () => void;
  /** 202: quem abriu mostra o aviso de enviada e fecha. */
  onSent: () => void;
  /** 404 (o alvo sumiu ou deixou de ser visível): quem abriu mostra o aviso e fecha. */
  onGone: () => void;
  /**
   * Onde aparece o erro do envio (429, 503, sem rede): num Toast, na rota `/denunciar`; ou numa
   * linha do próprio formulário (`inline`), no `Modal` do Conectar, porque o Toast ficaria atrás
   * dele (ux.md §11.14).
   */
  errorMode: 'toast' | 'inline';
  /** Nota abaixo da pergunta, com o relógio (o T46 no formulário aberto pelo cartão 11, 14 ou 22). */
  note?: string | undefined;
  /** O cabeçalho da pergunta, para quem abriu mover o foco até ele (Conectar, M8). */
  questionRef?: Ref<ViewInstance> | undefined;
  /** `testID` da linha de erro (`inline`). */
  errorTestID?: string | undefined;
}

/**
 * O formulário de denúncia (X.1): um dos 8 motivos (obrigatório), detalhes opcionais até 500
 * caracteres com contador e "Enviar". Serve à rota `/denunciar` e ao cartão do Conectar (ux.md
 * §11.14), com o mesmo conteúdo e os mesmos textos. Quem abre decide o que fazer depois do 202 e do
 * 404; os outros erros mantêm o formulário, com o motivo e o texto, para tentar de novo.
 */
export function ReportForm({
  target,
  onClose,
  onSent,
  onGone,
  errorMode,
  note,
  questionRef,
  errorTestID,
}: ReportFormProps) {
  const { api } = useAuth();
  const toast = useToast();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);
  /** O erro do envio na linha do formulário (`inline`); some no envio seguinte. */
  const [error, setError] = useState<string | null>(null);

  const tooLong = countChars(details) > REPORT_DETAILS_MAX_LENGTH;
  const canSend = reason !== null && !tooLong && !sending;

  const send = () => {
    if (reason === null || !canSend) return;
    setSending(true);
    setError(null);
    const trimmed = details.trim();
    createReport(api, { target, reason, ...(trimmed === '' ? {} : { details: trimmed }) })
      .then(() => {
        onSent();
      })
      .catch((failure: unknown) => {
        setSending(false);
        if (isApiError(failure, 'NOT_FOUND')) {
          onGone();
          return;
        }
        const message = messageForError(failure);
        if (errorMode === 'inline') {
          // A linha é anunciada uma vez, nos dois sistemas, sem região viva (ux.md §11.14, M11).
          setError(message);
          AccessibilityInfo.announceForAccessibility(message);
        } else {
          toast.show({ message, variant: 'error' });
        }
      });
  };

  return (
    <>
      <ScreenHeader
        variant="modal"
        title="Denunciar"
        left={{ label: 'Cancelar', onPress: onClose }}
        right={{ label: 'Enviar', primary: true, disabled: !canSend, onPress: send }}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View ref={questionRef} accessible accessibilityRole="header" testID="denuncia-pergunta">
            <Text variant="titleSm">{question(target)}</Text>
          </View>
          {note === undefined ? null : (
            <View style={styles.note}>
              <Icon name="clock" size={16} color="grey" />
              <Text variant="bodySm" color="grey" style={styles.flex}>
                {note}
              </Text>
            </View>
          )}
          {error === null ? null : (
            <Text
              variant="bodySm"
              color="danger"
              accessibilityLiveRegion="none"
              testID={errorTestID}
            >
              {error}
            </Text>
          )}
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
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: theme.layout.screenX, gap: theme.space[16] },
  note: { flexDirection: 'row', alignItems: 'center', gap: theme.space[8] },
});
