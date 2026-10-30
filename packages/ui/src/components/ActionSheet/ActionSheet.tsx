import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useReducedMotion } from '../../preferences';
import { theme } from '../../theme';
import { Text } from '../Text/Text';

export interface ActionSheetAction {
  label: string;
  onPress: () => void;
  /** Ação que corta ou apaga (texto em `danger`), ex.: "Bloquear". */
  destructive?: boolean;
}

export interface ActionSheetProps {
  visible: boolean;
  /** Contexto do menu (ex.: "Publicação de @marinac"), em `caption` grey no topo. */
  title?: string;
  actions: readonly ActionSheetAction[];
  /** Uma ação foi escolhida (quem controla fecha o menu e executa). */
  onSelect: (action: ActionSheetAction) => void;
  /** Fechou sem escolher: "Cancelar", toque fora ou voltar do Android. */
  onCancel: () => void;
  /** iOS: o Modal terminou de sair (só então dá para abrir um Alert ou navegar). */
  onDismiss?: () => void;
  testID?: string;
}

/**
 * Espera máxima pelo `onDismiss` do Modal no iOS antes de executar a ação escolhida. Objeto mutável
 * só para os testes zerarem a espera (o Modal dos testes não chama `onDismiss`).
 */
export const actionSheetTiming = {
  iosDismissFallbackMs: 500,
};

/**
 * Menu de ações em folha (menu ⋯ de posts, comentários e perfis, D-UX14): lista de ações e
 * "Cancelar" num cartão branco no rodapé, sobre o fundo escurecido. Feito com o `Modal` do React
 * Native porque o `Alert` do Android mostra no máximo 3 botões. Renderizado dentro da tela (e não
 * na raiz) para abrir também por cima da folha de comentários.
 */
export function ActionSheet({
  visible,
  title,
  actions,
  onSelect,
  onCancel,
  onDismiss,
  testID = 'action-sheet',
}: ActionSheetProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  return (
    <Modal
      visible={visible}
      transparent
      animationType={reduceMotion ? 'none' : 'fade'}
      statusBarTranslucent
      onRequestClose={onCancel}
      {...(onDismiss === undefined ? {} : { onDismiss })}
    >
      <View style={styles.backdrop} testID={testID}>
        {/* Toque fora fecha; para o leitor de tela, o caminho é "Cancelar". */}
        <Pressable
          style={StyleSheet.absoluteFill}
          accessible={false}
          importantForAccessibility="no"
          onPress={onCancel}
          testID={`${testID}-backdrop`}
        />
        <View
          accessibilityViewIsModal
          style={[styles.container, { paddingBottom: insets.bottom + theme.space[8] }]}
        >
          <View style={styles.card}>
            {title === undefined ? null : (
              <Text
                variant="caption"
                color="grey"
                align="center"
                accessibilityRole="header"
                style={styles.title}
              >
                {title}
              </Text>
            )}
            {actions.map((action, index) => (
              <Pressable
                key={action.label}
                testID={`${testID}-action-${String(index)}`}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                onPress={() => {
                  onSelect(action);
                }}
                style={({ pressed }) => [
                  styles.row,
                  (index > 0 || title !== undefined) && styles.divider,
                  pressed && styles.pressed,
                ]}
              >
                <Text variant="body" color={action.destructive === true ? 'danger' : 'black'}>
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancelar"
            onPress={onCancel}
            style={({ pressed }) => [styles.card, styles.row, pressed && styles.pressed]}
          >
            <Text variant="bodyStrong">Cancelar</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

export interface ShowActionSheetOptions {
  title?: string;
  actions: readonly ActionSheetAction[];
}

export interface UseActionSheet {
  show: (options: ShowActionSheetOptions) => void;
  /** Precisa estar na árvore da tela que abre o menu (é `null` antes do primeiro `show`). */
  element: ReactElement | null;
}

/**
 * Controla um `ActionSheet`: `show({ actions })` abre; a ação escolhida roda depois que o menu sai
 * da tela (no iOS, um `Alert` aberto durante a saída do Modal não aparece).
 */
export function useActionSheet(testID?: string): UseActionSheet {
  const [options, setOptions] = useState<ShowActionSheetOptions | null>(null);
  const [visible, setVisible] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runPending = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const action = pending.current;
    pending.current = null;
    action?.();
  }, []);

  // Saiu da tela com uma ação escolhida ainda na espera: executa assim mesmo.
  useEffect(() => runPending, [runPending]);

  const close = useCallback(
    (action: (() => void) | null) => {
      pending.current = action;
      setVisible(false);
      if (action === null) return;
      if (Platform.OS === 'ios') {
        timer.current = setTimeout(runPending, actionSheetTiming.iosDismissFallbackMs);
      } else {
        runPending();
      }
    },
    [runPending],
  );

  const show = useCallback((next: ShowActionSheetOptions) => {
    setOptions(next);
    setVisible(true);
  }, []);

  const element =
    options === null ? null : (
      <ActionSheet
        visible={visible}
        {...(options.title === undefined ? {} : { title: options.title })}
        actions={options.actions}
        onSelect={(action) => {
          close(action.onPress);
        }}
        onCancel={() => {
          close(null);
        }}
        onDismiss={runPending}
        {...(testID === undefined ? {} : { testID })}
      />
    );

  return { show, element };
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.overlay },
  container: { paddingHorizontal: theme.space[8], gap: theme.space[8] },
  card: {
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.xl,
    overflow: 'hidden',
  },
  title: { paddingHorizontal: theme.space[16], paddingVertical: theme.space[12] },
  row: {
    minHeight: theme.layout.rowMinHeight - theme.space[8],
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.space[16],
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border },
  pressed: { backgroundColor: theme.colors.greySoft },
});
