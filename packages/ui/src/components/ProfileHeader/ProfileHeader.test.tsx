import { screen, userEvent } from '@testing-library/react-native';

import {
  connectionButtonLabel,
  PRIVACY_NOTE,
  ProfileHeader,
  type ProfileHeaderSelfProps,
} from './ProfileHeader';
import { renderUi } from '../../test-utils/render';

function props(overrides: Partial<ProfileHeaderSelfProps> = {}): ProfileHeaderSelfProps {
  return {
    handle: 'helena',
    name: 'Helena Souza',
    bio: 'Arquiteta. Café coado.',
    counts: { accountType: 'personal', posts: 5, connections: 4, creators: 3 },
    onCreate: jest.fn(),
    onSignOut: jest.fn(),
    onEditProfile: jest.fn(),
    onPrimaryAction: jest.fn(),
    ...overrides,
  };
}

describe('ProfileHeader (próprio)', () => {
  it('p16: @ no topo, números de pessoal, tipo, bio, nota de privacidade e botões', async () => {
    await renderUi(<ProfileHeader {...props()} />);
    expect(screen.getByRole('header', { name: 'helena' })).toBeOnTheScreen();
    expect(screen.getByLabelText('5 publicações')).toBeOnTheScreen();
    expect(screen.getByLabelText('4 conexões')).toBeOnTheScreen();
    expect(screen.getByLabelText('3 criadores')).toBeOnTheScreen();
    expect(screen.getByText('Conta pessoal')).toBeOnTheScreen();
    expect(screen.getByText('Arquiteta. Café coado.')).toBeOnTheScreen();
    expect(screen.getByText(PRIVACY_NOTE)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Editar perfil' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Conectar ao vivo' })).toBeOnTheScreen();
  });

  it('p19: criador mostra publicações e seguidores, sem nota de privacidade, e "Nova publicação"', async () => {
    const onPrimaryAction = jest.fn();
    await renderUi(
      <ProfileHeader
        {...props({
          handle: 'cozinhadabia',
          counts: { accountType: 'creator', posts: 6, followers: 2418 },
          onPrimaryAction,
        })}
      />,
    );
    expect(screen.getByLabelText('2.418 seguidores')).toBeOnTheScreen();
    expect(screen.queryByText(PRIVACY_NOTE)).not.toBeOnTheScreen();
    expect(screen.getByText('Criador de conteúdo · não segue ninguém')).toBeOnTheScreen();
    // Seguidores nunca são tocáveis (ADR 0004).
    expect(screen.queryByRole('button', { name: '2.418 seguidores' })).not.toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Nova publicação' }));
    expect(onPrimaryAction).toHaveBeenCalled();
  });

  it('ícones do topo: Criar e Sair; números de listas só tocáveis quando há destino', async () => {
    const p = props({ bio: null, onOpenConnections: jest.fn() });
    await renderUi(<ProfileHeader {...p} />);
    await userEvent.press(screen.getByRole('button', { name: 'Criar publicação' }));
    await userEvent.press(screen.getByRole('button', { name: 'Sair da conta' }));
    expect(p.onCreate).toHaveBeenCalled();
    expect(p.onSignOut).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '4 conexões' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: '3 criadores' })).not.toBeOnTheScreen();
  });
});

describe('ProfileHeader (outra conta)', () => {
  it('p17: ‹ + @, números não tocáveis, sem nota de privacidade nem botões do dono', async () => {
    const onBack = jest.fn();
    await renderUi(
      <ProfileHeader
        mode="other"
        handle="trilhasdosul"
        name="Rafael Duarte"
        bio="Trilhas e acampamentos no Sul do Brasil."
        counts={{ accountType: 'creator', posts: 5, followers: 8903 }}
        onBack={onBack}
      />,
    );
    expect(screen.getByRole('header', { name: 'trilhasdosul' })).toBeOnTheScreen();
    expect(screen.getByLabelText('8.903 seguidores')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Editar perfil' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Sair da conta' })).not.toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Voltar' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('3.4 (p17): [Seguir] / (Seguindo) com a largura toda, rótulos do leitor de tela e o menu ⋯', async () => {
    const onFollow = jest.fn();
    const onMore = jest.fn();
    const base = {
      mode: 'other' as const,
      handle: 'trilhasdosul',
      name: 'Rafael Duarte',
      bio: null,
      counts: { accountType: 'creator' as const, posts: 5, followers: 8903 },
      onBack: jest.fn(),
      onMore,
    };
    await renderUi(<ProfileHeader {...base} follow={{ following: false, onPress: onFollow }} />);
    await userEvent.press(screen.getByRole('button', { name: 'Seguir @trilhasdosul' }));
    expect(onFollow).toHaveBeenCalledTimes(1);
    await userEvent.press(screen.getByRole('button', { name: 'Mais opções' }));
    expect(onMore).toHaveBeenCalledTimes(1);
    // Seguidores continuam sem toque (ADR 0004).
    expect(screen.queryByRole('button', { name: '8.903 seguidores' })).not.toBeOnTheScreen();

    await renderUi(<ProfileHeader {...base} follow={{ following: true, onPress: onFollow }} />);
    expect(screen.getByText('Seguindo')).toBeOnTheScreen();
    expect(
      screen.getByRole('button', {
        name: 'Seguindo @trilhasdosul, toque para deixar de seguir',
      }),
    ).toBeOnTheScreen();
  });

  it('ux.md §4.9: conexão vê os números sem toque e sem a nota de privacidade', async () => {
    await renderUi(
      <ProfileHeader
        mode="other"
        handle="marinac"
        name="Marina Costa"
        bio={null}
        counts={{ accountType: 'personal', posts: 3, connections: 1, creators: 2 }}
        onBack={jest.fn()}
      />,
    );
    expect(screen.getByLabelText('1 conexão')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: '1 conexão' })).not.toBeOnTheScreen();
    expect(screen.getByText('Conta pessoal')).toBeOnTheScreen();
    expect(screen.queryByText(PRIVACY_NOTE)).not.toBeOnTheScreen();
  });
});

describe('ProfileHeader (perfil de uma conexão, ux.md §4.9)', () => {
  it('4.9: (Conectados ✓) largura total, sem Seguir; o toque abre as opções', async () => {
    const onPress = jest.fn();
    await renderUi(
      <ProfileHeader
        mode="other"
        handle="caio.r"
        name="Caio Ribeiro"
        bio={null}
        counts={{ accountType: 'personal', posts: 2, connections: 7, creators: 1 }}
        onBack={jest.fn()}
        onMore={jest.fn()}
        connection={{ onPress }}
      />,
    );
    await userEvent.press(screen.getByRole('button', { name: connectionButtonLabel('caio.r') }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Conectados')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /Seguir/ })).not.toBeOnTheScreen();
    // A lista de conexões é privada: os números não são tocáveis.
    expect(screen.queryByRole('button', { name: '7 conexões' })).not.toBeOnTheScreen();
  });
});
