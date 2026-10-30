import {
  BIO_MAX_LENGTH,
  BioSchema,
  countChars,
  NAME_MAX_LENGTH,
  NameSchema,
} from '@sussurro/shared';
import { Avatar, Button, Input, ScreenHeader, Text, theme, useToast } from '@sussurro/ui';
import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAvatar } from './useAvatar';
import { isApiError, NetworkError } from '../../lib/api/errors';
import { messageForError, OFFLINE_MESSAGE } from '../../lib/error-messages';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';
import { ROUTES } from '../navigation/routes';

export const PROFILE_UPDATED_MESSAGE = 'Perfil atualizado.';
export const AVATAR_SHEET_TITLE = 'Foto de perfil';

function closeModal() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/');
  }
}

/**
 * Editar perfil (ux.md §4.6): nome e bio. O @ e o tipo de conta são só leitura (D17). "Concluir"
 * fica desabilitado sem mudanças. A foto (história 2.4) muda na hora, fora do "Concluir": "Alterar foto"
 * abre as opções "Escolher da galeria" e "Remover foto".
 */
export function EditarPerfilScreen() {
  const user = useSignedInUser();
  const { updateProfile } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [bio, setBio] = useState(user.bio ?? '');
  const [errors, setErrors] = useState<{ name?: string; bio?: string }>({});
  const [saving, setSaving] = useState(false);
  const avatar = useAvatar();

  const avatarOptions = () => {
    Alert.alert(AVATAR_SHEET_TITLE, undefined, [
      {
        text: 'Escolher da galeria',
        onPress: () => {
          void avatar.change();
        },
      },
      ...(user.avatarUrl === null
        ? []
        : [{ text: 'Remover foto', style: 'destructive' as const, onPress: avatar.remove }]),
      { text: 'Cancelar', style: 'cancel' as const },
    ]);
  };

  const nameResult = NameSchema.safeParse(name);
  const bioResult = BioSchema.safeParse(bio);
  const changed =
    (nameResult.success ? nameResult.data : name) !== user.name ||
    (bioResult.success ? bioResult.data : bio) !== user.bio;

  const save = async () => {
    const next: { name?: string; bio?: string } = {};
    if (!nameResult.success) next.name = nameResult.error.issues[0]?.message ?? 'Informe o nome.';
    if (!bioResult.success) next.bio = bioResult.error.issues[0]?.message ?? 'Bio longa demais.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSaving(true);
    try {
      await updateProfile({ name, bio });
      toast.show({ message: PROFILE_UPDATED_MESSAGE, variant: 'success' });
      closeModal();
    } catch (error) {
      if (error instanceof NetworkError) {
        toast.show({ message: OFFLINE_MESSAGE, variant: 'error' });
      } else if (isApiError(error, 'VALIDATION_ERROR')) {
        const fields = error.fieldPaths();
        setErrors({
          ...(fields.includes('name') ? { name: 'Confira o nome.' } : {}),
          ...(fields.includes('bio') ? { bio: 'Confira a bio.' } : {}),
        });
      } else {
        toast.show({ message: messageForError(error), variant: 'error' });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScreenHeader
        variant="modal"
        title="Editar perfil"
        left={{ label: 'Cancelar', onPress: closeModal }}
        right={{
          label: 'Concluir',
          primary: true,
          disabled: !changed || saving,
          onPress: () => {
            void save();
          },
        }}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.avatar} testID="editar-avatar">
            <View>
              <Avatar
                size={theme.size.avatar.profile}
                handle={user.handle}
                name={user.name}
                seed={user.id}
                uri={user.avatarUrl}
                testID="editar-avatar-imagem"
              />
              {avatar.busy ? (
                <View style={styles.avatarBusy}>
                  <ActivityIndicator
                    color={theme.colors.white}
                    accessibilityLabel="Enviando foto"
                  />
                </View>
              ) : null}
            </View>
            <Button
              variant="link"
              size="sm"
              label="Alterar foto"
              disabled={avatar.busy}
              onPress={avatarOptions}
            />
          </View>
          <Input
            label="Nome"
            value={name}
            onChangeText={setName}
            maxLength={NAME_MAX_LENGTH}
            countFn={countChars}
            testID="editar-nome"
            {...(errors.name === undefined ? {} : { error: errors.name })}
          />
          <Input
            label="Nome de usuário"
            value={user.handle}
            onChangeText={() => undefined}
            readOnly
            helper="Não dá para mudar na v1."
            testID="editar-handle"
          />
          <Input
            label="Bio"
            type="multiline"
            value={bio}
            onChangeText={setBio}
            maxLength={BIO_MAX_LENGTH}
            countFn={countChars}
            showCounter
            testID="editar-bio"
            {...(errors.bio === undefined ? {} : { error: errors.bio })}
          />
          <Input
            label="Tipo de conta"
            value={user.accountType === 'personal' ? 'Conta pessoal' : 'Criador de conteúdo'}
            onChangeText={() => undefined}
            readOnly
            testID="editar-tipo"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Conta e segurança"
            onPress={() => {
              router.push(ROUTES.account);
            }}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <Text variant="body" color="blue">
              Conta e segurança
            </Text>
            <Text variant="body" color="grey">
              ›
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  flex: { flex: 1 },
  content: { padding: theme.layout.screenX, gap: theme.space[12] },
  avatar: { alignItems: 'center', gap: theme.space[4] },
  avatarBusy: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: theme.size.avatar.profile / 2,
    backgroundColor: theme.colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: theme.layout.hitMin,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    marginTop: theme.space[8],
  },
  pressed: { opacity: theme.opacity.pressed },
});
