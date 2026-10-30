import { REPORT_REASON_LABELS, REPORT_REASONS, type ReportReason } from '@sussurro/shared';
import {
  Button,
  followButtonLabel,
  ProfileHeader,
  RadioOptionList,
  SearchBar,
  Text,
  theme,
  useActionSheet,
  UserRow,
} from '@sussurro/ui';
import { type ReactNode, useState } from 'react';
import { StyleSheet, View } from 'react-native';

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

function SearchBarBlock() {
  const [value, setValue] = useState('');
  return (
    <Block title="SearchBar">
      <Caption>Vazia (p15), com texto e "limpar", e carregando</Caption>
      <SearchBar value={value} onChangeText={setValue} testID="catalog-search-empty" />
      <SearchBar value="estudio" onChangeText={noop} testID="catalog-search-filled" />
      <SearchBar value="estudio" onChangeText={noop} loading testID="catalog-search-loading" />
    </Block>
  );
}

function FollowButton({ handle }: { handle: string }) {
  const [following, setFollowing] = useState(false);
  return (
    <Button
      variant={following ? 'secondary' : 'primary'}
      size="sm"
      label={following ? 'Seguindo' : 'Seguir'}
      accessibilityLabel={followButtonLabel(handle, following)}
      onPress={() => {
        setFollowing((value) => !value);
      }}
    />
  );
}

function UserRowBlock() {
  return (
    <Block title="UserRow">
      <Caption>Busca (p15), "Criadores que sigo" e bloqueados</Caption>
      <View style={styles.card}>
        <UserRow
          handle="estudioaurora"
          name="Estúdio Aurora"
          subtitle="Estúdio Aurora · 5.067 seguidores"
          onPress={noop}
          action={<FollowButton handle="estudioaurora" />}
          testID="catalog-user-row-search"
        />
        <UserRow
          handle="trilhasdosul"
          name="Rafael Duarte"
          subtitle="Rafael Duarte · desde 27 out"
          onPress={noop}
          action={<Button variant="secondary" size="sm" label="Seguindo" onPress={noop} />}
        />
        <UserRow
          handle="caio.r"
          subtitle="Bloqueio em 27 out"
          action={<Button variant="secondary" size="sm" label="Desbloquear" onPress={noop} />}
        />
      </View>
    </Block>
  );
}

function ActionSheetBlock() {
  const menu = useActionSheet('catalog-action-sheet');
  return (
    <Block title="ActionSheet">
      <Caption>Menu ⋯ de posts, comentários e perfis (D-UX14)</Caption>
      <Button
        variant="secondary"
        size="sm"
        label="Abrir menu ⋯"
        onPress={() => {
          menu.show({
            title: 'Publicação de @marinac',
            actions: [
              { label: 'Denunciar', onPress: noop },
              { label: 'Bloquear', destructive: true, onPress: noop },
            ],
          });
        }}
      />
      {menu.element}
    </Block>
  );
}

function ReportReasonsBlock() {
  const [reason, setReason] = useState<ReportReason | null>(null);
  return (
    <Block title="Motivos da denúncia">
      <Caption>RadioOptionList sem escolha inicial (X.1)</Caption>
      <RadioOptionList
        legend="Motivo"
        options={REPORT_REASONS.map((key) => ({ key, title: REPORT_REASON_LABELS[key] }))}
        value={reason}
        onChange={setReason}
        testID="catalog-report-reasons"
      />
    </Block>
  );
}

function CreatorProfileBlock() {
  const [following, setFollowing] = useState(false);
  return (
    <Block title="ProfileHeader (criador visto por pessoa, p17)">
      <View style={styles.card}>
        <ProfileHeader
          mode="other"
          handle="trilhasdosul"
          name="Rafael Duarte"
          bio="Trilhas e acampamentos no Sul do Brasil."
          counts={{ accountType: 'creator', posts: 5, followers: 8903 }}
          onBack={noop}
          onMore={noop}
          follow={{
            following,
            onPress: () => {
              setFollowing((value) => !value);
            },
          }}
          testID="catalog-profile-p17"
        />
      </View>
    </Block>
  );
}

/** Componentes da Fase 3 (busca, seguir, listas, denunciar e bloquear). */
export function Phase3Components() {
  return (
    <>
      <SearchBarBlock />
      <UserRowBlock />
      <CreatorProfileBlock />
      <ActionSheetBlock />
      <ReportReasonsBlock />
    </>
  );
}

const styles = StyleSheet.create({
  block: { gap: theme.space[12] },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.lg,
    overflow: 'hidden',
    paddingBottom: theme.space[12],
  },
});
