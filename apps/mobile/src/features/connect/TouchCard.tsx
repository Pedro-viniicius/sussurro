import type { ConnectionRequestParty } from '@sussurro/shared';
import { Avatar, Button, Text, theme, useReducedMotion } from '@sussurro/ui';
import { useEffect, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { useFocusOnShowUnlessHeld } from './a11y';
import { COPY, firstName, formatCountdown } from './copy';
import { blockedMessage } from '../moderation/useBlockAccount';
import { BLOCK_ACTION, REPORT_ACTION } from '../moderation/useModerationMenu';

/** A linha ‹Denunciar› ‹Bloquear› do cartão (ux.md §11.14). */
export interface TouchCardModeration {
  /**
   * A linha está na tela. No 14, some no `actionsUntil` do cartão, com fade de 200 ms (M14); no 14
   * de um cartão atrasado, nunca aparece (§11.15).
   */
  visible: boolean;
  /** No Bloqueado só há o ‹Denunciar›. */
  canBlock: boolean;
  /** "Bloquear" confirmado e em andamento (M3): o ‹Bloquear› em `loading`, o resto desativado. */
  blocking: boolean;
  /** O Conectar ou o Aceitar em andamento: a linha fica desativada, como o ‹Cancelar›. */
  disabled: boolean;
  onReport: () => void;
  onBlock: () => void;
}

interface CommonProps {
  person: ConnectionRequestParty;
  moderation: TouchCardModeration;
  /** Muda para o foco voltar ao cabeçalho do cartão (M9, M12, M14). */
  focusRun: number;
  /** O `Alert` ou o formulário de denúncia por cima: o foco espera (M15, M16). */
  focusHeld: boolean;
}

/**
 * As variantes do cartão (ux.md §11.5, §11.14 e §11.15): `touched` (11, quem encostou),
 * `alreadyConnected` (12, quem já é conexão), `incoming` (14, o pedido dessa mesma pessoa, no
 * próprio cartão), `blocked` (o Bloqueado, depois do "Bloquear" no 11, no 14 ou no 22), `late` (21,
 * o cartão atrasado: sem ação nenhuma) e `noConnect` (22, o cartão sem Conectar: só a linha).
 */
export type TouchCardProps = CommonProps &
  (
    | { variant: 'touched'; busy: boolean; onConnect: () => void; onCancel: () => void }
    | { variant: 'alreadyConnected'; onBack: () => void }
    | { variant: 'late'; onBack: () => void }
    | { variant: 'noConnect'; onBack: () => void }
    | {
        variant: 'incoming';
        secondsLeft: number;
        busy: boolean;
        /** O aceite que não deu certo (o pedido continua valendo), como na folha. */
        error: string | null;
        onAccept: () => void;
        onDecline: () => void;
      }
    | { variant: 'blocked'; onBack: () => void }
  );

/** Entrada com fade de 200 ms (sem fade com "Reduzir movimento"). */
function useFadeIn() {
  const reduceMotion = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(reduceMotion ? 1 : 0));
  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return undefined;
    }
    const fade = Animated.timing(opacity, {
      toValue: 1,
      duration: theme.motion.base,
      useNativeDriver: true,
    });
    fade.start();
    return () => {
      fade.stop();
    };
  }, [opacity, reduceMotion]);
  return opacity;
}

/**
 * ‹Denunciar› ‹Bloquear›: dois `link sm` centralizados, 32 abaixo do último elemento e 32 entre
 * eles, quebrando em duas linhas com fonte grande. Nenhum fica vermelho (o vermelho é o do `Alert`).
 * Quando some (M14), sai com fade de 200 ms, já fora do leitor de tela. A que nunca esteve na tela
 * (o 14 de um cartão atrasado, §11.15) não aparece nem para sumir.
 */
function ModerationLine({ moderation }: { moderation: TouchCardModeration }) {
  const { visible, canBlock, blocking, disabled, onReport, onBlock } = moderation;
  const reduceMotion = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(1));
  const [faded, setFaded] = useState(false);
  // Guarda se a linha já esteve na tela (o padrão do React para o estado que vem do render anterior).
  const [everShown, setEverShown] = useState(visible);
  if (visible && !everShown) setEverShown(true);
  useEffect(() => {
    if (visible) {
      opacity.setValue(1);
      return undefined;
    }
    if (reduceMotion) return undefined;
    const fade = Animated.timing(opacity, {
      toValue: 0,
      duration: theme.motion.base,
      useNativeDriver: true,
    });
    fade.start(({ finished }) => {
      if (finished) setFaded(true);
    });
    return () => {
      fade.stop();
    };
  }, [opacity, reduceMotion, visible]);

  if (!visible && (!everShown || reduceMotion || faded)) return null;
  const leaving = !visible;
  return (
    <Animated.View
      style={[styles.moderation, { opacity }]}
      accessibilityElementsHidden={leaving}
      importantForAccessibility={leaving ? 'no-hide-descendants' : 'auto'}
    >
      <Button
        variant="link"
        size="sm"
        label={REPORT_ACTION}
        disabled={disabled || blocking || leaving}
        onPress={onReport}
        testID="cartao-denunciar"
      />
      {canBlock ? (
        <Button
          variant="link"
          size="sm"
          label={BLOCK_ACTION}
          loading={blocking}
          disabled={disabled || leaving}
          onPress={onBlock}
          testID="cartao-bloquear"
        />
      ) : null}
    </Animated.View>
  );
}

/**
 * O cartão de quem encostou (ux.md §11.5): Avatar 72, o nome (recebe o foco), o @ e a verificação,
 * com "Conectar com Caio" e "Cancelar". Quando o pedido dessa pessoa chega, o cartão vira o pedido
 * e o botão principal fica no mesmo lugar e com o mesmo estilo (um toque na troca conecta do mesmo
 * jeito, P5). O cartão não some quando os celulares se afastam. Enquanto vale, "Denunciar" e
 * "Bloquear" ficam no fim, num grupo à parte (§11.14).
 */
export function TouchCard(props: TouchCardProps) {
  const { person, variant, moderation, focusRun, focusHeld } = props;
  const first = firstName(person.name);
  const opacity = useFadeIn();
  const focusRef = useFocusOnShowUnlessHeld(
    `${variant}:${person.handle}:${String(focusRun)}`,
    focusHeld,
  );
  const { blocking } = moderation;
  const line = <ModerationLine moderation={moderation} />;

  const avatar = (
    <Avatar
      size={theme.size.avatar['3xl']}
      handle={person.handle}
      name={person.name}
      uri={person.avatarUrl}
      decorative
    />
  );

  if (props.variant === 'incoming') {
    return (
      <Animated.View style={[styles.card, { opacity }]} testID="conectar-pedido-cartao">
        {avatar}
        <View ref={focusRef} accessible accessibilityRole="header" testID="cartao-titulo">
          <Text variant="titleMd" align="center">
            {COPY.sheetTitle(first)}
          </Text>
        </View>
        <Text variant="bodySm" color="grey" align="center">
          {`@${person.handle} · ${person.name}`}
        </Text>
        <Text variant="bodySm" color="grey" align="center" style={styles.check}>
          {COPY.sheetConfirm(first)}
        </Text>
        <View style={styles.actions}>
          <Button
            fullWidth
            label={COPY.accept}
            loading={props.busy}
            disabled={blocking}
            onPress={props.onAccept}
            testID="cartao-principal"
          />
          <Button
            fullWidth
            variant="secondary"
            label={COPY.decline}
            disabled={props.busy || blocking}
            onPress={props.onDecline}
          />
        </View>
        {props.error === null ? null : (
          <Text
            variant="bodySm"
            color="danger"
            align="center"
            accessibilityLiveRegion="polite"
            testID="cartao-erro"
          >
            {props.error}
          </Text>
        )}
        {/* O prazo não é anunciado a cada segundo. */}
        <Text
          variant="caption"
          color="grey"
          align="center"
          accessibilityLiveRegion="none"
          testID="cartao-prazo"
        >
          {COPY.expiresIn(formatCountdown(props.secondsLeft))}
        </Text>
        {line}
      </Animated.View>
    );
  }

  let body;
  switch (props.variant) {
    case 'touched':
      body = (
        <>
          <Text variant="bodySm" color="grey" align="center" style={styles.check}>
            {COPY.cardCheck}
          </Text>
          <View style={styles.actions}>
            <Button
              fullWidth
              label={COPY.connectWith(first)}
              accessibilityLabel={COPY.connectWithLabel(person.name, person.handle)}
              loading={props.busy}
              disabled={blocking}
              onPress={props.onConnect}
              testID="cartao-principal"
            />
          </View>
          <View style={styles.link}>
            <Button
              variant="link"
              size="sm"
              label={COPY.cancel}
              disabled={props.busy || blocking}
              onPress={props.onCancel}
            />
          </View>
        </>
      );
      break;
    case 'alreadyConnected':
    case 'blocked':
    case 'late':
    case 'noConnect':
      // O (Voltar) secundário no lugar do botão principal, com as medidas do 12 (a 24 do texto).
      body = (
        <>
          <Text variant="bodySm" color="grey" align="center" style={styles.check}>
            {backCardText(props.variant, person.handle, first)}
          </Text>
          <View style={styles.actions}>
            <Button
              fullWidth
              variant="secondary"
              label={COPY.back}
              disabled={blocking}
              onPress={props.onBack}
            />
          </View>
        </>
      );
      break;
  }

  return (
    <Animated.View style={[styles.card, { opacity }]} testID={TEST_ID[props.variant]}>
      {avatar}
      <View ref={focusRef} accessible accessibilityRole="header" testID="cartao-nome">
        <Text variant="titleMd" align="center">
          {person.name}
        </Text>
      </View>
      <Text variant="bodySm" color="grey" align="center">
        {`@${person.handle}`}
      </Text>
      {body}
      {/* O 21 não tem ação nenhuma: o par venceu ou vence em menos de 10 s (A3-4). */}
      {props.variant === 'late' ? null : line}
    </Animated.View>
  );
}

const TEST_ID: Record<Exclude<TouchCardProps['variant'], 'incoming'>, string> = {
  touched: 'conectar-encostado',
  alreadyConnected: 'conectar-encostado-conectados',
  blocked: 'conectar-encostado-bloqueado',
  late: 'conectar-encostado-atrasado',
  noConnect: 'conectar-encostado-sem-conectar',
};

/** O texto no lugar do T15 nos cartões só com (Voltar): o T18, o Bloqueado, o T47 e o T48. */
function backCardText(
  variant: 'alreadyConnected' | 'blocked' | 'late' | 'noConnect',
  handle: string,
  first: string,
): string {
  switch (variant) {
    case 'alreadyConnected':
      return COPY.alreadyConnected;
    case 'blocked':
      return blockedMessage(handle);
    case 'late':
      return COPY.lateCardText(first);
    case 'noConnect':
      return COPY.noConnectCardText(first);
  }
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    gap: theme.space[8],
    paddingTop: theme.space[32],
    paddingHorizontal: theme.layout.screenX,
  },
  check: { maxWidth: 300 },
  actions: { alignSelf: 'stretch', gap: theme.space[8], marginTop: theme.space[16] },
  link: { alignItems: 'center', marginTop: theme.space[4] },
  // 32 abaixo do último elemento (8 do `gap` do cartão + 24), 32 entre as ações e 8 entre as linhas
  // quando quebram (ux.md §11.14).
  moderation: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    columnGap: theme.space[32],
    rowGap: theme.space[8],
    marginTop: theme.space[24],
  },
});
