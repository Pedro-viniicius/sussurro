import { Redirect } from 'expo-router';

import { ROUTES } from '../navigation/routes';

/** Aba "fantasma": a barra intercepta o toque e abre o modal `/criar` (ux.md §3.2). */
export function CreateTabRedirect() {
  return <Redirect href={ROUTES.create} />;
}
