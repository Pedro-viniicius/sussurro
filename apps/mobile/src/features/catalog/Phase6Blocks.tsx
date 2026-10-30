import {
  followersBadge,
  type Notification,
  notificationPlainText,
  notificationTextParts,
} from '@sussurro/shared';
import { Button, IconButton, NotificationRow, Text, theme, useToast } from '@sussurro/ui';
import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { catalogImages } from './images';
import { sendTestError } from '../../lib/sentry';

const noop = () => undefined;

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.block}>
      <Text variant="titleSm" accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Caption({ children }: { children: string }) {
  return (
    <Text variant="caption" color="grey">
      {children}
    </Text>
  );
}

const [azul, verde, areia] = catalogImages;
const ISO = '2026-10-30T12:00:00.000Z';
const base = { read: true, createdAt: ISO, updatedAt: ISO };
const person = (handle: string, name: string, profileVisible = true) => ({
  handle,
  name,
  avatarUrl: null,
  accountType: 'personal' as const,
  profileVisible,
});

/** As linhas de p09 e p21, com os textos do `packages/shared`. */
interface Example {
  notification: Notification;
  time: string;
  thumb?: { key: string; uri: string | null };
}

const LIKED: Example = {
  notification: {
    ...base,
    read: false,
    id: '00000000-0000-4000-8000-000000000901',
    type: 'post_liked',
    actor: person('marinac', 'Marina Costa'),
    post: { id: '00000000-0000-4000-8000-000000000a01', type: 'photo', thumbUrl: azul.uri },
  },
  time: '20 min',
  thumb: { key: 'p09-1', uri: azul.uri },
};

const COMMENTED: Example = {
  notification: {
    ...base,
    id: '00000000-0000-4000-8000-000000000902',
    type: 'post_commented',
    actor: person('lucasf', 'Lucas Ferreira'),
    post: { id: '00000000-0000-4000-8000-000000000a02', type: 'photo', thumbUrl: verde.uri },
    excerpt: 'Que luz bonita!',
  },
  time: '1 h',
  thumb: { key: 'p09-2', uri: verde.uri },
};

const REPLIED: Example = {
  notification: {
    ...base,
    id: '00000000-0000-4000-8000-000000000903',
    type: 'comment_replied',
    actor: person('tomas.o', 'Tomás Oliveira'),
    post: { id: '00000000-0000-4000-8000-000000000a03', type: 'text', thumbUrl: null },
    excerpt: 'Combinado, levo a sobremesa.',
  },
  time: '3 h',
};

const CONNECTED: Example = {
  notification: {
    ...base,
    id: '00000000-0000-4000-8000-000000000904',
    type: 'connection_created',
    actor: person('caio.r', 'Caio Ribeiro'),
  },
  time: '2 d',
};

const FOLLOWERS_TODAY: Example = {
  notification: {
    ...base,
    read: false,
    id: '00000000-0000-4000-8000-000000000911',
    type: 'new_followers',
    count: 2,
  },
  time: '10 min',
};

const REEL_COMMENT: Example = {
  notification: {
    ...base,
    id: '00000000-0000-4000-8000-000000000912',
    type: 'post_commented',
    // Conta pessoal comentando no post do criador: o @ não é tocável (D11).
    actor: person('lucasf', 'Lucas Ferreira', false),
    post: { id: '00000000-0000-4000-8000-000000000a12', type: 'reel', thumbUrl: areia.uri },
    excerpt: 'Preciso aprender essa dobra.',
  },
  time: '2 h',
  thumb: { key: 'p21-2', uri: areia.uri },
};

const FOLLOWERS_WEEK: Example = {
  notification: {
    ...base,
    id: '00000000-0000-4000-8000-000000000913',
    type: 'new_followers',
    count: 5,
  },
  time: '1 d',
};

function ExampleRow({ example }: { example: Example }) {
  const { notification, time, thumb } = example;
  const avatar =
    notification.type === 'new_followers'
      ? {
          kind: 'aggregate' as const,
          count: notification.count,
          label: followersBadge(notification.count),
        }
      : {
          kind: 'account' as const,
          handle: notification.actor.handle,
          name: notification.actor.name,
        };
  const tappable = notification.type !== 'new_followers' && notification.actor.profileVisible;
  return (
    <NotificationRow
      parts={notificationTextParts(notification)}
      time={time}
      avatar={avatar}
      thumbnail={
        thumb === undefined || thumb.uri === null ? null : { key: thumb.key, uri: thumb.uri }
      }
      unread={!notification.read}
      accessibilityLabel={`${notificationPlainText(notification)} ${time}`}
      {...(notification.type === 'new_followers' ? {} : { onPress: noop })}
      {...(tappable ? { onPressHandle: noop } : {})}
      testID={`catalog-notificacao-${notification.id}`}
    />
  );
}

/** Componentes da Fase 6 (ux.md §6.14): NotificationRow e o coração com o ponto azul. */
export function Phase6Components() {
  const toast = useToast();
  return (
    <>
      <Block title="NotificationRow">
        <Caption>
          Não lida (ponto azul), com miniatura, sem miniatura (texto) e agregada "+N"
        </Caption>
        <View style={styles.bleed}>
          <ExampleRow example={LIKED} />
          <ExampleRow example={REPLIED} />
          <ExampleRow example={FOLLOWERS_TODAY} />
        </View>
      </Block>
      <Block title="Coração do Início">
        <Caption>Sem novidades e com o ponto azul (6.2)</Caption>
        <View style={styles.row}>
          <IconButton icon="heart" accessibilityLabel="Notificações" onPress={noop} />
          <IconButton
            icon="heart"
            accessibilityLabel="Notificações, há novidades"
            onPress={noop}
            dot
            testID="catalog-coracao"
          />
        </View>
      </Block>
      <Block title="Sentry (6.7 CA3)">
        <Caption>
          Manda um erro de teste: no Sentry, o stack com source maps, a release e o ambiente
        </Caption>
        <Button
          variant="secondary"
          size="sm"
          label="Enviar erro de teste"
          onPress={() => {
            toast.show(
              sendTestError()
                ? { message: 'Erro de teste enviado ao Sentry.', variant: 'success' }
                : { message: 'O Sentry está desligado (sem DSN).' },
            );
          }}
        />
      </Block>
    </>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Text variant="titleSm" style={styles.sectionTitle}>
      {children}
    </Text>
  );
}

/** p09 e p21 montadas com os componentes, para comparar com o protótipo. */
export function NotificationScreens() {
  return (
    <>
      <Block title="Notificações (p09)">
        <View style={styles.bleed} testID="catalog-notificacoes-p09">
          <SectionTitle>Hoje</SectionTitle>
          {[LIKED, COMMENTED, REPLIED].map((example) => (
            <ExampleRow key={example.notification.id} example={example} />
          ))}
          <SectionTitle>Esta semana</SectionTitle>
          <ExampleRow example={CONNECTED} />
          <Text variant="bodySm" color="grey" align="center" style={styles.end}>
            Isso é tudo por enquanto.
          </Text>
        </View>
      </Block>
      <Block title="Notificações do criador (p21)">
        <View style={styles.bleed} testID="catalog-notificacoes-p21">
          <SectionTitle>Hoje</SectionTitle>
          <ExampleRow example={FOLLOWERS_TODAY} />
          <ExampleRow example={REEL_COMMENT} />
          <SectionTitle>Esta semana</SectionTitle>
          <ExampleRow example={FOLLOWERS_WEEK} />
        </View>
      </Block>
    </>
  );
}

const styles = StyleSheet.create({
  block: { gap: theme.space[12] },
  row: { flexDirection: 'row', gap: theme.space[12] },
  bleed: { marginHorizontal: -theme.layout.screenX },
  sectionTitle: {
    paddingHorizontal: theme.layout.screenX,
    paddingTop: theme.space[12],
    paddingBottom: theme.space[4],
  },
  end: { paddingVertical: theme.space[16] },
});
