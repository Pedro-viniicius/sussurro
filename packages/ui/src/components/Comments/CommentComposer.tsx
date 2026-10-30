import { type ReactNode, type Ref, useImperativeHandle, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, type TextInputInstance, View } from 'react-native';

import type { ComposerUser } from './types';
import { useFontScale } from '../../preferences';
import { theme } from '../../theme';
import { Avatar } from '../Avatar/Avatar';
import { Icon } from '../Icon/Icon';
import { Text } from '../Text/Text';

export interface CommentComposerProps {
  user: ComposerUser;
  /** `@handle` de quem está sendo respondido: mostra o chip "Respondendo a @x ✕". */
  replyingTo?: string | null;
  onCancelReply?: () => void;
  /** Chamado com o texto digitado; o campo limpa na hora (o item aparece "enviando" na lista). */
  onSubmit: (body: string) => void;
  /** Limite e contagem (o app passa a contagem de packages/shared: code points, TXT-04). */
  maxLength: number;
  countFn?: (value: string) => number;
  /** O texto pode ser enviado (não vazio, não só invisíveis, dentro do limite). */
  validate?: (value: string) => boolean;
  /** O contador "x/500" aparece a partir daqui (ux.md §4.3: 450). */
  counterFrom?: number;
  placeholder?: string;
  /** Aviso acima do campo (ex.: confirmar o e-mail). */
  notice?: ReactNode;
  ref?: Ref<CommentComposerHandle>;
  testID?: string;
}

export interface CommentComposerHandle {
  focus: () => void;
}

/**
 * Campo de comentário (ux.md §4.3): avatar 32, campo com borda de raio total e "Publicar" azul
 * (desabilitado em `blueMist`). Fica acima do teclado (quem usa põe num `KeyboardAvoidingView`).
 */
export function CommentComposer({
  user,
  replyingTo,
  onCancelReply,
  onSubmit,
  maxLength,
  countFn,
  validate,
  counterFrom = 450,
  placeholder = 'Adicione um comentário…',
  notice,
  testID = 'comment-composer',
  ref,
}: CommentComposerProps) {
  const fontScale = useFontScale();
  const [value, setValue] = useState('');
  const input = useRef<TextInputInstance>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  const count = countFn === undefined ? value.length : countFn(value);
  const valid =
    validate === undefined ? value.trim() !== '' && count <= maxLength : validate(value);
  const showCounter = count >= counterFrom;

  const submit = () => {
    if (!valid) return;
    onSubmit(value);
    setValue('');
  };

  return (
    <View testID={testID} style={styles.container}>
      {notice}
      {replyingTo === undefined || replyingTo === null ? null : (
        <View style={styles.chip} testID={`${testID}-replying`}>
          <Text variant="bodySm" color="greyStrong" style={styles.flex}>
            Respondendo a @{replyingTo}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancelar resposta"
            hitSlop={10}
            onPress={onCancelReply}
          >
            <Icon name="x" size={16} color="greyStrong" />
          </Pressable>
        </View>
      )}
      <View style={styles.row}>
        <Avatar
          size={theme.size.avatar.sm}
          handle={user.handle}
          {...(user.name === undefined ? {} : { name: user.name })}
          {...(user.seed === undefined ? {} : { seed: user.seed })}
          {...(user.avatarUri === undefined ? {} : { uri: user.avatarUri })}
          decorative
        />
        <TextInput
          ref={input}
          testID={`${testID}-input`}
          value={value}
          onChangeText={setValue}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.grey}
          accessibilityLabel={
            replyingTo === undefined || replyingTo === null
              ? 'Comentário'
              : `Resposta para @${replyingTo}`
          }
          multiline
          maxFontSizeMultiplier={theme.type.bodySm.maxFontSizeMultiplier}
          style={[
            styles.input,
            {
              fontFamily: theme.fonts.regular,
              fontSize: theme.type.bodySm.fontSize * fontScale,
            },
          ]}
        />
        <Pressable
          testID={`${testID}-submit`}
          accessibilityRole="button"
          accessibilityLabel="Publicar"
          accessibilityState={{ disabled: !valid }}
          disabled={!valid}
          hitSlop={8}
          onPress={submit}
          style={styles.submit}
        >
          <Text variant="buttonSm" color={valid ? 'blue' : 'blueMist'}>
            Publicar
          </Text>
        </Pressable>
      </View>
      {showCounter ? (
        <Text
          variant="caption"
          color={count > maxLength ? 'danger' : 'grey'}
          align="right"
          tabularNums
          accessibilityLiveRegion="polite"
          testID={`${testID}-counter`}
        >
          {`${count}/${maxLength}`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.space[8],
    paddingHorizontal: theme.layout.screenX,
    paddingVertical: theme.space[8],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.white,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[8],
    backgroundColor: theme.colors.greySoft,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space[12],
    paddingVertical: theme.space[6],
  },
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space[12] },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 20,
    paddingHorizontal: theme.space[16],
    paddingTop: 10,
    paddingBottom: 10,
    color: theme.colors.black,
  },
  submit: { minHeight: theme.layout.hitMin, justifyContent: 'center' },
});
