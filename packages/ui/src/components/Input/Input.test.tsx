import { screen, userEvent } from '@testing-library/react-native';
import { useState } from 'react';

import { Input, type InputProps } from './Input';
import { renderUi } from '../../test-utils/render';
import { theme } from '../../theme';

function Controlled(props: Omit<InputProps, 'value' | 'onChangeText'> & { initial?: string }) {
  const { initial = '', ...rest } = props;
  const [value, setValue] = useState(initial);
  return <Input {...rest} value={value} onChangeText={setValue} />;
}

describe('Input', () => {
  it('vazio: o rótulo é o placeholder e o campo tem nome acessível', async () => {
    await renderUi(<Input label="E-mail" value="" onChangeText={jest.fn()} />);
    expect(screen.getByPlaceholderText('E-mail')).toBeOnTheScreen();
    expect(screen.getByLabelText('E-mail')).toBeOnTheScreen();
  });

  it('preenchido: o rótulo flutua acima do valor', async () => {
    await renderUi(<Controlled label="E-mail" initial="ana@x.com" />);
    expect(screen.getByText('E-mail')).toBeOnTheScreen();
    expect(screen.getByDisplayValue('ana@x.com')).toBeOnTheScreen();
    expect(screen.queryByPlaceholderText('E-mail')).not.toBeOnTheScreen();
  });

  it('email: teclado de e-mail, sem maiúsculas automáticas', async () => {
    await renderUi(<Input label="E-mail" type="email" value="" onChangeText={jest.fn()} />);
    expect(screen.getByLabelText('E-mail').props).toMatchObject({
      keyboardType: 'email-address',
      autoCapitalize: 'none',
      textContentType: 'emailAddress',
    });
  });

  it('username converte para minúsculas ao digitar', async () => {
    await renderUi(<Controlled label="Nome de usuário" type="username" />);
    await userEvent.type(screen.getByLabelText('Nome de usuário'), 'MarinaC');
    expect(screen.getByDisplayValue('marinac')).toBeOnTheScreen();
  });

  it('senha: oculta por padrão, botão Mostrar/Ocultar alterna', async () => {
    await renderUi(<Controlled label="Senha" type="password" passwordPurpose="new" />);
    const field = screen.getByLabelText('Senha');
    expect(field.props.secureTextEntry).toBe(true);
    expect(field.props.textContentType).toBe('newPassword');
    await userEvent.press(screen.getByRole('button', { name: 'Mostrar senha' }));
    expect(screen.getByLabelText('Senha').props.secureTextEntry).toBe(false);
    expect(screen.getByRole('button', { name: 'Ocultar senha' })).toBeOnTheScreen();
  });

  it('erro: borda danger e mensagem como alerta', async () => {
    await renderUi(
      <Input label="E-mail" value="x" onChangeText={jest.fn()} error="E-mail inválido" />,
    );
    expect(screen.getByTestId('input-error-message')).toHaveProp('accessibilityRole', 'alert');
    expect(screen.getByText('E-mail inválido')).toHaveStyle({ color: theme.colors.danger });
    expect(screen.getByLabelText('E-mail').props.accessibilityHint).toBe('E-mail inválido');
  });

  it('helper aparece quando não há erro', async () => {
    await renderUi(
      <Input label="Nome" value="" onChangeText={jest.fn()} helper="Como aparece no perfil" />,
    );
    expect(screen.getByText('Como aparece no perfil')).toBeOnTheScreen();
  });

  it('somente leitura: não editável e estado desabilitado', async () => {
    await renderUi(<Input label="E-mail" value="ana@x.com" onChangeText={jest.fn()} readOnly />);
    const field = screen.getByLabelText('E-mail');
    expect(field.props.editable).toBe(false);
    expect(field).toBeDisabled();
  });

  it('contador x/máximo, anunciado só perto do limite', async () => {
    await renderUi(
      <>
        <Input
          label="Texto"
          type="multiline"
          value={'a'.repeat(10)}
          onChangeText={jest.fn()}
          maxLength={280}
          showCounter
        />
        <Input
          label="Outro texto"
          value={'a'.repeat(265)}
          onChangeText={jest.fn()}
          maxLength={280}
          showCounter
          testID="perto"
        />
      </>,
    );
    const counter = screen.getByTestId('input-counter', { includeHiddenElements: true });
    expect(counter).toHaveTextContent('10/280');
    expect(counter.props.accessibilityLiveRegion).toBeUndefined();

    expect(screen.getByTestId('perto-counter').props.accessibilityLiveRegion).toBe('polite');
  });

  it('[TXT-04] countFn: o contador conta code points (emoji vale 1) e fica danger acima do limite', async () => {
    const codePoints = (value: string) => Array.from(value).length;
    await renderUi(
      <Input
        label="Bio"
        type="multiline"
        value={'😀'.repeat(151)}
        onChangeText={jest.fn()}
        maxLength={150}
        showCounter
        countFn={codePoints}
      />,
    );
    const counter = screen.getByTestId('input-counter', { includeHiddenElements: true });
    expect(counter).toHaveTextContent('151/150');
    expect(counter).toHaveStyle({ color: '#D32F2F' });
    // Sem maxLength nativo: o TextInput cortaria o emoji pela metade (UTF-16).
    expect(screen.getByTestId('input').props.maxLength).toBeUndefined();
  });
});
