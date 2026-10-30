import { feedWindowLabel } from '@sussurro/shared';
import {
  Avatar,
  BottomTabBar,
  type BottomTabKey,
  brandColorTokens,
  Button,
  type ButtonVariant,
  CaughtUp,
  type ColorToken,
  EmptyState,
  Icon,
  iconNames,
  Input,
  type InputProps,
  Logo,
  STAT_LABELS,
  StatsRow,
  Text,
  theme,
  Toast,
  ToastProvider,
  TopTabs,
  type TypeToken,
  UiPreferencesProvider,
  useToast,
} from '@sussurro/ui';
import { router } from 'expo-router';
import { type ReactNode, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { contrastRatio } from './contrast';
import { catalogPeople, typeSample } from './fixtures';
import { ComposedScreens, Phase2Components } from './Phase2Blocks';
import { Phase3Components } from './Phase3Blocks';
import { Phase4Components } from './Phase4Blocks';
import { Phase5Components, ReelsFeedScreen } from './Phase5Blocks';
import { NotificationScreens, Phase6Components } from './Phase6Blocks';
import { errorMessage } from '../../lib/error-messages';

const SECTIONS = [
  { key: 'fundamentos', title: 'Fundamentos' },
  { key: 'marca', title: 'Marca' },
  { key: 'icones', title: 'Ícones' },
  { key: 'componentes', title: 'Componentes' },
  { key: 'fase2', title: 'Posts e comentários' },
  { key: 'fase3', title: 'Busca, seguir e menus' },
  { key: 'fase4', title: 'Conectar' },
  { key: 'fase5', title: 'Reels' },
  { key: 'fase6', title: 'Notificações' },
  { key: 'telas', title: 'Telas compostas' },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

const FONT_SCALES = [1, 1.3, 2] as const;
const HEX = /^#[0-9A-F]{6}$/i;

/**
 * Catálogo do design system (ux.md §6.15): os componentes base da Fase 0, os da Fase 2 (posts,
 * comentários, Criar, perfil) e os da Fase 3 (busca, seguir, menu ⋯, denúncia) com variantes e
 * estados, e as telas do feed montadas com fixtures para conferir com p06 e p07. Só existe em dev
 * (`/dev/catalog`).
 */
export function CatalogScreen() {
  const [fontScale, setFontScale] = useState<number>(1);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [surface, setSurface] = useState<'white' | 'greySoft'>('white');
  const scrollRef = useRef<ScrollViewInstance>(null);
  const offsets = useRef<Partial<Record<SectionKey, number>>>({});

  const goTo = (key: SectionKey) => {
    scrollRef.current?.scrollTo({ y: offsets.current[key] ?? 0, animated: !reduceMotion });
  };

  return (
    <UiPreferencesProvider fontScale={fontScale} reduceMotion={reduceMotion}>
      <ToastProvider>
        <SafeAreaView
          edges={['top', 'left', 'right']}
          style={[styles.screen, { backgroundColor: theme.colors[surface] }]}
        >
          <View style={styles.header}>
            <Button
              variant="link"
              size="sm"
              label="Voltar"
              icon="chevron-left"
              onPress={() => {
                if (router.canGoBack()) {
                  router.back();
                } else {
                  router.replace('/');
                }
              }}
            />
            <Text variant="titleLg" accessibilityRole="header">
              Catálogo
            </Text>
          </View>

          <View style={styles.controls}>
            <View style={styles.controlRow}>
              <Text variant="bodySm">Reduzir movimento (simular)</Text>
              <Switch
                accessibilityLabel="Reduzir movimento (simular)"
                value={reduceMotion}
                onValueChange={setReduceMotion}
                trackColor={{ true: theme.colors.blue, false: theme.colors.border }}
              />
            </View>
            <View style={styles.controlRow}>
              <Text variant="bodySm">Escala de fonte</Text>
              <View style={styles.inline}>
                {FONT_SCALES.map((scale) => (
                  <Chip
                    key={scale}
                    label={scale.toFixed(1).replace('.', ',')}
                    accessibilityLabel={`Escala de fonte ${scale.toFixed(1).replace('.', ',')}`}
                    selected={fontScale === scale}
                    onPress={() => {
                      setFontScale(scale);
                    }}
                  />
                ))}
              </View>
            </View>
            <View style={styles.controlRow}>
              <Text variant="bodySm">Fundo</Text>
              <View style={styles.inline}>
                {(['white', 'greySoft'] as const).map((value) => (
                  <Chip
                    key={value}
                    label={value}
                    accessibilityLabel={`Fundo ${value}`}
                    selected={surface === value}
                    onPress={() => {
                      setSurface(value);
                    }}
                  />
                ))}
              </View>
            </View>
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
            style={styles.chipsBar}
          >
            {SECTIONS.map((section) => (
              <Chip
                key={section.key}
                label={section.title}
                accessibilityLabel={`Ir para ${section.title}`}
                selected={false}
                onPress={() => {
                  goTo(section.key);
                }}
              />
            ))}
          </ScrollView>

          <ScrollView
            ref={scrollRef}
            testID="catalog-scroll"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.content}
          >
            {SECTIONS.map((section) => (
              <View
                key={section.key}
                testID={`catalog-section-${section.key}`}
                onLayout={(event) => {
                  offsets.current[section.key] = event.nativeEvent.layout.y;
                }}
                style={styles.section}
              >
                <Text variant="titleLg" accessibilityRole="header">
                  {section.title}
                </Text>
                {section.key === 'fundamentos' ? <Foundations /> : null}
                {section.key === 'marca' ? <Brand /> : null}
                {section.key === 'icones' ? <Icons /> : null}
                {section.key === 'componentes' ? <Components /> : null}
                {section.key === 'fase2' ? <Phase2Components /> : null}
                {section.key === 'fase3' ? <Phase3Components /> : null}
                {section.key === 'fase4' ? <Phase4Components /> : null}
                {section.key === 'fase5' ? <Phase5Components /> : null}
                {section.key === 'fase6' ? <Phase6Components /> : null}
                {section.key === 'telas' ? (
                  <>
                    <ComposedScreens />
                    <ReelsFeedScreen />
                    <NotificationScreens />
                  </>
                ) : null}
              </View>
            ))}
          </ScrollView>
        </SafeAreaView>
      </ToastProvider>
    </UiPreferencesProvider>
  );
}

function Chip({
  label,
  accessibilityLabel,
  selected,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      hitSlop={6}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text variant="buttonSm" color={selected ? 'white' : 'black'}>
        {label}
      </Text>
    </Pressable>
  );
}

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

function Foundations() {
  const colorTokens = Object.keys(theme.colors) as ColorToken[];
  const brand = new Set<string>(brandColorTokens);
  return (
    <>
      <Block title="Cores">
        {colorTokens.map((token) => {
          const value = theme.colors[token];
          const solid = HEX.test(value);
          return (
            <View key={token} style={styles.swatchRow}>
              <View style={[styles.swatch, { backgroundColor: value }]} />
              <View style={styles.flex}>
                <Text variant="bodyStrong">
                  {token}
                  {brand.has(token) ? ' · PO' : ''}
                </Text>
                <Text variant="caption" color="grey">
                  {value}
                  {solid
                    ? ` · ${contrastRatio(value, theme.colors.white).toFixed(2)}:1 sobre white · ${contrastRatio(value, theme.colors.greySoft).toFixed(2)}:1 sobre greySoft`
                    : ''}
                </Text>
              </View>
            </View>
          );
        })}
      </Block>

      <Block title="Pastéis do avatar">
        <View style={styles.wrap}>
          {catalogPeople.map((person) => (
            <View key={person.handle} style={styles.avatarSample}>
              <Avatar size={48} handle={person.handle} name={person.name} />
              <Text variant="caption" color="grey">
                @{person.handle}
              </Text>
            </View>
          ))}
        </View>
      </Block>

      <Block title="Tipografia">
        {(Object.keys(theme.type) as TypeToken[]).map((token) => (
          <View key={token}>
            <Text variant="caption" color="grey">
              {token} · {theme.type[token].fontSize}/{theme.type[token].lineHeight}
            </Text>
            <Text variant={token}>{typeSample}</Text>
          </View>
        ))}
      </Block>

      <Block title="Espaçamento">
        {Object.values(theme.space).map((value) => (
          <View key={value} style={styles.inline}>
            <Text variant="caption" color="grey" style={styles.label}>
              {value}
            </Text>
            <View style={[styles.spaceBar, { width: Math.max(1, value * 3) }]} />
          </View>
        ))}
      </Block>

      <Block title="Raios">
        <View style={styles.wrap}>
          {Object.entries(theme.radius).map(([name, value]) => (
            <View key={name} style={styles.radiusSample}>
              <View style={[styles.radiusBox, { borderRadius: Math.min(value, 28) }]} />
              <Text variant="caption" color="grey">
                {name} {value}
              </Text>
            </View>
          ))}
        </View>
      </Block>
    </>
  );
}

function Brand() {
  const surfaces: { key: string; background: string; tone: 'default' | 'onBrand' }[] = [
    { key: 'white', background: theme.colors.white, tone: 'default' },
    { key: 'blue', background: theme.colors.blue, tone: 'onBrand' },
    { key: 'black', background: theme.colors.black, tone: 'onBrand' },
  ];
  return (
    <>
      {surfaces.map((item) => (
        <Block key={item.key} title={`Logo sobre ${item.key}`}>
          <View style={[styles.brandSurface, { backgroundColor: item.background }]}>
            <View style={styles.wrap}>
              {[16, 24, 32, 64, 96].map((size) => (
                <Logo key={size} size={size} tone={item.tone} testID={`logo-${item.key}-${size}`} />
              ))}
            </View>
            <Logo variant="lockup" size={24} tone={item.tone} testID={`lockup-${item.key}`} />
            <Logo
              variant="lockup"
              layout="stacked"
              size={64}
              tone={item.tone}
              testID={`lockup-stacked-${item.key}`}
            />
          </View>
        </Block>
      ))}
    </>
  );
}

function Icons() {
  return (
    <View style={styles.wrap}>
      {iconNames.map((name) => (
        <View key={name} style={styles.iconCell}>
          <View style={styles.inline}>
            <Icon name={name} />
            <Icon name={name} active />
          </View>
          <Text variant="caption" color="grey" numberOfLines={1}>
            {name}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Components() {
  return (
    <>
      <AvatarBlock />
      <ButtonBlock />
      <InputBlock />
      <TopTabsBlock />
      <BottomTabBarBlock />
      <ToastBlock />
      <Block title="EmptyState">
        <EmptyState
          icon="lock"
          title="Indisponível para criadores"
          description="Contas de criador não se conectam com outras pessoas. Elas só publicam e podem ser seguidas."
          primaryAction={{ label: 'Voltar ao perfil', onPress: () => undefined }}
        />
        <EmptyState
          icon="wifi-off"
          title="Sem internet"
          description="Confira a conexão e tente de novo."
          primaryAction={{ label: 'Tentar de novo', onPress: () => undefined }}
          secondaryAction={{ label: 'Ver ajuda', onPress: () => undefined }}
          testID="empty-offline"
        />
      </Block>
      <Block title="CaughtUp">
        <CaughtUp kind="photo" windowLabel={feedWindowLabel(72)} />
        <CaughtUp kind="text" windowLabel={feedWindowLabel(24)} testID="caught-up-text" />
        <CaughtUp kind="reel" windowLabel={feedWindowLabel(36)} testID="caught-up-reel" />
      </Block>
      <Block title="StatsRow">
        <StatsRow
          items={[
            { value: 1, label: STAT_LABELS.posts },
            { value: 8_903, label: STAT_LABELS.connections, onPress: () => undefined },
            { value: 12, label: STAT_LABELS.creators, onPress: () => undefined },
          ]}
        />
        <StatsRow
          testID="stats-creator"
          items={[
            { value: 48, label: STAT_LABELS.posts },
            { value: 1_200_000, label: STAT_LABELS.followers },
          ]}
        />
      </Block>
    </>
  );
}

function AvatarBlock() {
  return (
    <Block title="Avatar">
      <View style={styles.wrap}>
        {([24, 32, 36, 44, 48, 64, 72, 86] as const).map((size) => (
          <Avatar key={size} size={size} handle="marinac" name="Marina Costa" />
        ))}
      </View>
      <View style={styles.wrap}>
        <Avatar size={24} handle="helena" name="Helena Souza" ring />
        <Avatar size={44} handle="cozinhadabia" count={2} />
        <Avatar
          size={44}
          handle="juprado"
          name="Juliana Prado"
          uri="https://invalido.local/x.jpg"
        />
        <Avatar size={44} handle="trilhasdosul" />
      </View>
      <Text variant="caption" color="grey">
        Tamanhos; com anel; agregado +N; foto que falhou (fica nas iniciais); sem nome.
      </Text>
    </Block>
  );
}

function ButtonBlock() {
  const variants: ButtonVariant[] = ['primary', 'secondary', 'link', 'destructive'];
  const noop = () => undefined;
  return (
    <Block title="Button">
      {variants.map((variant) => (
        <View key={variant} style={styles.stack}>
          <Text variant="caption" color="grey">
            {variant}
          </Text>
          <View style={styles.wrap}>
            <Button variant={variant} label="Padrão" onPress={noop} />
            <Button variant={variant} label="Pressionado" forcePressed onPress={noop} />
            <Button variant={variant} label="Desabilitado" disabled onPress={noop} />
            <Button variant={variant} label="Carregando" loading onPress={noop} />
            <Button variant={variant} label="Pequeno" size="sm" onPress={noop} />
          </View>
        </View>
      ))}
      <Button label="Largura total" fullWidth onPress={noop} />
    </Block>
  );
}

function DemoInput(props: Omit<InputProps, 'value' | 'onChangeText'> & { initial?: string }) {
  const { initial = '', ...rest } = props;
  const [value, setValue] = useState(initial);
  return <Input {...rest} value={value} onChangeText={setValue} />;
}

function InputBlock() {
  return (
    <Block title="Input">
      <DemoInput label="E-mail" type="email" testID="input-empty" />
      <DemoInput label="E-mail" type="email" initial="helena@exemplo.com" testID="input-filled" />
      <DemoInput label="Nome" initial="Helena" forceFocused testID="input-focused" />
      <DemoInput label="Senha" type="password" initial="segredo123" testID="input-password" />
      <DemoInput label="Nome de usuário" type="username" initial="helena" testID="input-username" />
      <DemoInput
        label="E-mail"
        type="email"
        initial="helena@"
        error="Digite um e-mail válido."
        testID="input-error"
      />
      <DemoInput label="Nome" helper="É assim que você aparece no perfil." testID="input-helper" />
      <DemoInput label="E-mail" initial="helena@exemplo.com" readOnly testID="input-readonly" />
      <DemoInput
        label="O que você quer contar?"
        type="multiline"
        maxLength={280}
        showCounter
        initial="Domingo de manhã no Passaúna."
        testID="input-multiline"
      />
    </Block>
  );
}

function TopTabsBlock() {
  const [feed, setFeed] = useState<'photo' | 'text' | 'reel'>('photo');
  const [profile, setProfile] = useState<'grid' | 'text' | 'reel'>('grid');
  return (
    <Block title="TopTabs">
      <TopTabs
        testID="tabs-feed"
        value={feed}
        onChange={setFeed}
        tabs={[
          { key: 'photo', label: 'Fotos', accessibilityLabel: 'Fotos' },
          { key: 'text', label: 'Textos', accessibilityLabel: 'Textos' },
          { key: 'reel', label: 'Reels', accessibilityLabel: 'Reels' },
        ]}
      />
      <TopTabs
        testID="tabs-profile"
        variant="icon"
        value={profile}
        onChange={setProfile}
        tabs={[
          { key: 'grid', icon: 'grid-3x3', accessibilityLabel: 'Fotos do perfil' },
          { key: 'text', icon: 'align-left', accessibilityLabel: 'Textos do perfil' },
          { key: 'reel', icon: 'square-play', accessibilityLabel: 'Reels do perfil' },
        ]}
      />
    </Block>
  );
}

function BottomTabBarBlock() {
  const [personal, setPersonal] = useState<BottomTabKey>('home');
  const [creator, setCreator] = useState<BottomTabKey>('profile');
  return (
    <Block title="BottomTabBar">
      <Text variant="caption" color="grey">
        Pessoal
      </Text>
      <BottomTabBar
        testID="tabbar-personal"
        variant="personal"
        active={personal}
        avatar={{ handle: 'helena', name: 'Helena Souza' }}
        onPress={setPersonal}
      />
      <Text variant="caption" color="grey">
        Criador (com notificações não lidas)
      </Text>
      <BottomTabBar
        testID="tabbar-creator"
        variant="creator"
        active={creator}
        hasUnread
        avatar={{ handle: 'cozinhadabia', name: 'Cozinha da Bia' }}
        onPress={setCreator}
      />
    </Block>
  );
}

function ToastBlock() {
  const toast = useToast();
  return (
    <Block title="Toast">
      <Toast message="Publicação compartilhada." variant="success" testID="toast-success" />
      <Toast message={errorMessage('INTERNAL_ERROR')} variant="error" testID="toast-error" />
      <Toast
        message="Comentário apagado."
        action={{ label: 'Desfazer', onPress: () => undefined }}
        testID="toast-action"
      />
      <Button
        variant="secondary"
        size="sm"
        label="Mostrar Toast"
        onPress={() => {
          toast.show({ message: errorMessage('RATE_LIMITED'), variant: 'error' });
        }}
      />
    </Block>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[12],
    minHeight: theme.layout.headerHeight,
    paddingHorizontal: theme.layout.screenX,
  },
  controls: { paddingHorizontal: theme.layout.screenX, gap: theme.space[8] },
  controlRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: theme.space[8] },
  chipsBar: { flexGrow: 0 },
  chips: {
    gap: theme.space[8],
    paddingHorizontal: theme.layout.screenX,
    paddingVertical: theme.space[12],
  },
  chip: {
    minHeight: 32,
    paddingHorizontal: theme.space[12],
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.greySoft,
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: theme.colors.black },
  content: { paddingHorizontal: theme.layout.screenX, paddingBottom: theme.space[64] },
  section: { gap: theme.space[16], paddingTop: theme.space[24] },
  block: { gap: theme.space[12] },
  stack: { gap: theme.space[6] },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space[12] },
  flex: { flex: 1 },
  swatchRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space[12] },
  swatch: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  avatarSample: { alignItems: 'center', gap: theme.space[4], width: 96 },
  label: { width: 32 },
  spaceBar: { height: 12, backgroundColor: theme.colors.blueMist },
  radiusSample: { alignItems: 'center', gap: theme.space[4] },
  radiusBox: { width: 56, height: 56, backgroundColor: theme.colors.blueLight },
  brandSurface: {
    padding: theme.space[16],
    borderRadius: theme.radius.xl,
    gap: theme.space[16],
    alignItems: 'flex-start',
  },
  iconCell: { width: 96, gap: theme.space[4] },
});
