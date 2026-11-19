import type { NearbyPerson } from '@sussurro/shared';
import { Avatar, Button, Text, theme, useReducedMotion } from '@sussurro/ui';
import { useEffect, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { useFocusOnShow } from './a11y';
import { COPY, firstName } from './copy';

export interface PersonCardProps {
  /** A pessoa do código lido (`resolve`). */
  person: NearbyPerson;
  /** O pedido para essa pessoa (ou o aceite do pedido dela) em andamento. */
  busy: boolean;
  onConnect: () => void;
  /** "Cancelar" (ou "Voltar", com quem já é conexão): de volta à leitura. */
  onBack: () => void;
}

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
 * O cartão da pessoa cujo código foi lido, por QR ou NFC (ADR 0013 §5; ux.md §11.5): Avatar 72, o
 * nome (recebe o foco), o @ e a verificação, com "Conectar com Caio" e "Cancelar". Nada sai sem o
 * toque em "Conectar", também quando o código veio do deep link ou de uma tag lida com o app
 * fechado. Quem já é conexão vê "Vocês já estão conectados." com "Voltar". Sem ‹Denunciar› e
 * ‹Bloquear›: antes do pedido não há relação com a pessoa (eles ficam na folha do pedido recebido).
 */
export function PersonCard({ person, busy, onConnect, onBack }: PersonCardProps) {
  const first = firstName(person.name);
  const opacity = useFadeIn();
  const variant = person.alreadyConnected ? 'conectados' : 'pessoa';
  const focusRef = useFocusOnShow(`${variant}:${person.handle}`);

  return (
    <Animated.View
      style={[styles.card, { opacity }]}
      testID={person.alreadyConnected ? 'conectar-cartao-conectados' : 'conectar-cartao'}
    >
      <Avatar
        size={theme.size.avatar['3xl']}
        handle={person.handle}
        name={person.name}
        uri={person.avatarUrl}
        decorative
      />
      <View ref={focusRef} accessible accessibilityRole="header" testID="cartao-nome">
        <Text variant="titleMd" align="center">
          {person.name}
        </Text>
      </View>
      <Text variant="bodySm" color="grey" align="center">
        {`@${person.handle}`}
      </Text>
      <Text variant="bodySm" color="grey" align="center" style={styles.check}>
        {person.alreadyConnected ? COPY.alreadyConnected : COPY.cardCheck}
      </Text>
      {person.alreadyConnected ? (
        <View style={styles.actions}>
          <Button fullWidth variant="secondary" label={COPY.back} onPress={onBack} />
        </View>
      ) : (
        <>
          <View style={styles.actions}>
            <Button
              fullWidth
              label={COPY.connectWith(first)}
              accessibilityLabel={COPY.connectWithLabel(person.name, person.handle)}
              loading={busy}
              onPress={onConnect}
              testID="cartao-principal"
            />
          </View>
          <View style={styles.link}>
            <Button variant="link" size="sm" label={COPY.cancel} disabled={busy} onPress={onBack} />
          </View>
        </>
      )}
    </Animated.View>
  );
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
});
