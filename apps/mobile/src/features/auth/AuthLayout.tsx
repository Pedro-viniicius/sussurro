import { Button, Logo, Text, theme } from '@sussurro/ui';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export interface AuthLayoutProps {
  /** Frase sob a tagline (ex.: "Cadastre-se para ver quem você conhece. Só isso."). */
  intro?: string;
  children: ReactNode;
  /** Rodapé fixo: pergunta + link (p01/p05). */
  footer?: { question: string; linkLabel: string; onPress: () => void };
}

/** Moldura das telas sem sessão (p01, p05): logo centralizado, campos e rodapé com link. */
export function AuthLayout({ intro, children, footer }: AuthLayoutProps) {
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Logo
              variant="lockup"
              layout="stacked"
              size={56}
              accessibilityRole="header"
              accessibilityLabel="Sussurro"
            />
            <Text variant="body" color="grey" align="center">
              A rede social sem algoritmo.
            </Text>
            {intro === undefined ? null : (
              <Text variant="bodyStrong" color="grey" align="center" style={styles.intro}>
                {intro}
              </Text>
            )}
          </View>
          <View style={styles.form}>{children}</View>
        </ScrollView>
        {footer === undefined ? null : (
          <View style={styles.footer}>
            <Text variant="bodySm" color="grey">
              {footer.question}
            </Text>
            <Button variant="link" size="sm" label={footer.linkLabel} onPress={footer.onPress} />
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Mensagem de erro do formulário inteiro, sob os campos (ux.md §5.1). */
export function FormError({ message }: { message: string | undefined }) {
  if (message === undefined) {
    return null;
  }
  return (
    <Text
      variant="bodySm"
      color="danger"
      align="center"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="form-error"
    >
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: theme.layout.authX,
    paddingVertical: theme.space[32],
    gap: theme.space[24],
  },
  brand: { alignItems: 'center', gap: theme.space[12] },
  intro: { marginTop: theme.space[8] },
  form: { gap: theme.layout.fieldGap },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[6],
    paddingVertical: theme.space[16],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
});
