/** Comentário como o design system mostra (o app faz o mapeamento da API). */
export interface CommentView {
  id: string;
  /** `null` no comentário de primeiro nível; o id do comentário respondido numa resposta. */
  parentId: string | null;
  author: {
    handle: string;
    name?: string;
    avatarUri?: string | null;
    /** O @ só é tocável quando o perfil é visível para quem lê (D11, PERM-10c). */
    profileVisible: boolean;
  };
  body: string;
  createdAt: string | Date;
  /** Quem lê pode apagar (autor do comentário ou do post). */
  canDelete: boolean;
  /** Envio otimista: `sending` fica a 50%; `failed` mostra "Não publicado. Tentar de novo". */
  status?: 'sent' | 'sending' | 'failed';
}

export interface CommentThreadView extends CommentView {
  replies: readonly CommentView[];
}

export interface ComposerUser {
  handle: string;
  name?: string;
  avatarUri?: string | null;
  seed?: string;
}
