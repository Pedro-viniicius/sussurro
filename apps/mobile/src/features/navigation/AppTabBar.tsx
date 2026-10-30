import { BottomTabBar, type BottomTabKey } from '@sussurro/ui';
import { router } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/js-tabs';

import { ROUTES } from './routes';
import { useAuth } from '../auth/AuthProvider';
import { useNotifications } from '../notifications/NotificationsProvider';

/** Nome do arquivo da rota (dentro de `pessoal/` ou `criador/`) → aba do design system. */
const TAB_BY_ROUTE: Record<string, BottomTabKey> = {
  inicio: 'home',
  pesquisar: 'search',
  'criar-aba': 'create',
  conectar: 'connect',
  perfil: 'profile',
  notificacoes: 'notifications',
};

export interface AppTabBarProps extends BottomTabBarProps {
  variant: 'personal' | 'creator';
}

/**
 * Barra inferior por tipo de conta (história 1.9): pessoal = Início, Pesquisar, Criar, Conectar,
 * Perfil; criador = Notificações, Criar, Perfil. "Criar" não é aba: abre o modal (ux.md §3.2).
 */
export function AppTabBar({ state, navigateToTab, variant }: AppTabBarProps) {
  const { user } = useAuth();
  const { unreadCount } = useNotifications();
  const current = state.routes[state.index];
  const active = (current === undefined ? undefined : TAB_BY_ROUTE[current.name]) ?? 'profile';

  return (
    <BottomTabBar
      variant={variant}
      active={active}
      // Ponto azul na aba Notificações do criador (6.2); a pessoa vê no coração do Início.
      hasUnread={variant === 'creator' && unreadCount > 0}
      testID={`tabbar-${variant}`}
      avatar={{
        handle: user?.handle ?? '',
        ...(user === null ? {} : { name: user.name, seed: user.id }),
      }}
      onPress={(key) => {
        if (key === 'create') {
          router.push(ROUTES.create);
          return;
        }
        const target = state.routes.find((route) => TAB_BY_ROUTE[route.name] === key);
        if (target !== undefined) {
          navigateToTab(target.key);
        }
      }}
    />
  );
}
