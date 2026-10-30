import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';

import { useFontScale } from '../../preferences';
import { theme } from '../../theme';
import { Icon } from '../Icon/Icon';
import { Text } from '../Text/Text';

export type InputType = 'text' | 'email' | 'password' | 'username' | 'multiline';

export interface InputProps {
  /** Vira placeholder com o campo vazio e rótulo flutuante quando preenchido. */
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  type?: InputType;
  error?: string;
  helper?: string;
  maxLength?: number;
  showCounter?: boolean;
  /**
   * Como contar os caracteres do contador (padrão: `length`). Para nome e bio, passe o
   * `countChars` de packages/shared (code points, emoji = 1, TXT-04).
   */
  countFn?: (value: string) => number;
  readOnly?: boolean;
  /** Senha no Cadastro: `newPassword` (gerenciadores sugerem uma senha nova). */
  passwordPurpose?: 'current' | 'new';
  onBlur?: () => void;
  onSubmitEditing?: () => void;
  /** Força a borda de foco (só para o catálogo). */
  forceFocused?: boolean;
  testID?: string;
}

/** O contador só é anunciado pelo leitor de tela perto do limite (ux.md §6.13). */
const COUNTER_ANNOUNCE_REMAINING = 20;

function keyboardProps(type: InputType, passwordPurpose: 'current' | 'new'): TextInputProps {
  switch (type) {
    case 'email':
      return {
        keyboardType: 'email-address',
        autoCapitalize: 'none',
        autoCorrect: false,
        autoComplete: 'email',
        textContentType: 'emailAddress',
      };
    case 'password':
      return {
        autoCapitalize: 'none',
        autoCorrect: false,
        autoComplete: passwordPurpose === 'new' ? 'new-password' : 'current-password',
        textContentType: passwordPurpose === 'new' ? 'newPassword' : 'password',
      };
    case 'username':
      return {
        autoCapitalize: 'none',
        autoCorrect: false,
        autoComplete: 'username',
        textContentType: 'username',
      };
    case 'multiline':
      return { multiline: true, textAlignVertical: 'top' };
    case 'text':
      return {};
  }
}

export function Input({
  label,
  value,
  onChangeText,
  type = 'text',
  error,
  helper,
  maxLength,
  showCounter = false,
  countFn,
  readOnly = false,
  passwordPurpose = 'current',
  onBlur,
  onSubmitEditing,
  forceFocused = false,
  testID = 'input',
}: InputProps) {
  const fontScale = useFontScale();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const filled = value.length > 0;
  const hasError = error !== undefined && error !== '';
  const isPassword = type === 'password';

  const borderColor = hasError
    ? theme.colors.danger
    : (focused || forceFocused) && !readOnly
      ? theme.colors.grey
      : theme.colors.border;

  const fieldStyle: ViewStyle = {
    minHeight: type === 'multiline' ? theme.size.input * 2 : theme.size.input,
    borderColor,
  };

  const handleChange = (text: string) => {
    // @ do usuário sempre em minúsculas (ux.md §6.13).
    onChangeText(type === 'username' ? text.toLocaleLowerCase('pt-BR') : text);
  };

  const count = countFn === undefined ? value.length : countFn(value);
  const remaining = maxLength === undefined ? undefined : maxLength - count;

  return (
    <View style={styles.wrapper}>
      <View style={[styles.field, fieldStyle]}>
        <View style={styles.inputArea}>
          {filled ? (
            <Text variant="caption" color="grey" accessible={false}>
              {label}
            </Text>
          ) : null}
          <TextInput
            testID={testID}
            value={value}
            onChangeText={handleChange}
            onFocus={() => {
              setFocused(true);
            }}
            onBlur={() => {
              setFocused(false);
              onBlur?.();
            }}
            {...(onSubmitEditing === undefined ? {} : { onSubmitEditing })}
            placeholder={filled ? undefined : label}
            placeholderTextColor={theme.colors.grey}
            accessibilityLabel={label}
            {...(hasError ? { accessibilityHint: error } : {})}
            accessibilityState={{ disabled: readOnly }}
            editable={!readOnly}
            secureTextEntry={isPassword && !revealed}
            {...(maxLength === undefined || countFn !== undefined ? {} : { maxLength })}
            maxFontSizeMultiplier={theme.type.bodyLg.maxFontSizeMultiplier}
            style={[
              styles.input,
              {
                fontFamily: theme.fonts.regular,
                fontSize: theme.type.bodyLg.fontSize * fontScale,
                color: readOnly ? theme.colors.grey : theme.colors.black,
              },
            ]}
            {...keyboardProps(type, passwordPurpose)}
          />
        </View>
        {isPassword ? (
          <Pressable
            testID={`${testID}-reveal`}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Ocultar senha' : 'Mostrar senha'}
            hitSlop={8}
            onPress={() => {
              setRevealed((current) => !current);
            }}
            style={styles.reveal}
          >
            <Text variant="buttonSm">{revealed ? 'Ocultar' : 'Mostrar'}</Text>
          </Pressable>
        ) : null}
      </View>

      {hasError ? (
        <View
          testID={`${testID}-error-message`}
          style={styles.message}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          <Icon name="circle-alert" size={14} color="danger" />
          <Text variant="caption" color="danger" testID={`${testID}-error`}>
            {error}
          </Text>
        </View>
      ) : helper === undefined ? null : (
        <Text variant="caption" color="grey" style={styles.message}>
          {helper}
        </Text>
      )}

      {showCounter && maxLength !== undefined && remaining !== undefined ? (
        <Text
          variant="caption"
          color={remaining < 0 ? 'danger' : 'grey'}
          align="right"
          tabularNums
          testID={`${testID}-counter`}
          accessibilityLabel={`${remaining} caracteres restantes`}
          {...(remaining <= COUNTER_ANNOUNCE_REMAINING
            ? { accessibilityLiveRegion: 'polite' as const }
            : { accessibilityElementsHidden: true, importantForAccessibility: 'no' as const })}
        >
          {`${count}/${maxLength}`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 4, alignSelf: 'stretch' },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.field,
    paddingHorizontal: theme.space[16],
    paddingVertical: theme.space[4],
  },
  inputArea: { flex: 1, justifyContent: 'center' },
  input: { paddingVertical: 4, paddingHorizontal: 0 },
  reveal: { marginLeft: theme.space[8], minHeight: 32, justifyContent: 'center' },
  message: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
