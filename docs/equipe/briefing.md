# Briefing do PO — Sussurro v1 (MVP)

> Especificação original do Product Owner (transcrita na íntegra) + decisões do kickoff + notas do protótipo.
> Este arquivo é a entrada da equipe. A fonte da verdade consolidada é `PROJETO.md`.

## Decisões do kickoff (2026-10-29)
- Monorepo em `C:\dev\sussurro` (fora do OneDrive). Protótipo original em `docs/design/prototipo/` (PDF + PNG por página + texto extraído).
- Ferramentas instaladas na máquina do PO (Windows 11): Node v26.13.0, Git 2.56, Docker Desktop, Poppler. pnpm instalado à parte (o Node 26 não traz corepack; corrigido na consolidação).
- iOS: EAS Build + conta Apple Developer + iPhone físico. A máquina de desenvolvimento é Windows (sem Xcode).
- Modo de trabalho: fases. Parar ao fim de cada fase para revisão do PO. Nada fora do escopo. Antes de escrever código, apresentar o plano da Fase 0 e a estrutura de pastas.

## Notas do protótipo (`docs/design/prototipo/p-XX.png`, 22 páginas)
- p01 login · p02–03 abertura/splash · p04 marca (símbolo, versões, cores) · p05 cadastro · p06 feed Fotos · p07 feed Textos · p08 feed Reels + "Você está em dia" · p09 notificações (pessoal) · p10–14 Conectar (inicial, procurando, por perto, aguardando, conectados) · p15 busca · p16 perfil pessoal · p17 perfil de criador visto por pessoa · p18 criar (pessoal) · p19 perfil do próprio criador · p20 criar (criador) · p21 notificações do criador (agregadas) · p22 Conectar bloqueado para criador.
- Itens do protótipo que parecem ser só de demo: "Entrar na conta de criador (demo)" (login) e "Simular um pedido recebido" (Conectar).
- O login do protótipo diz "E-mail ou nome de usuário"; a especificação diz e-mail e senha.
- Os avatares sem foto usam fundos pastel (lilás, verde-menta, pêssego, azul claro) que não estão nos tokens.
- O protótipo mostra distância aproximada ("a ~1 m") na lista Por perto.
- A tagline é "A rede social sem algoritmo."; o slogan da marca é "Só quem está perto ouve."

---

# Especificação original

## 1. Produto
- Sem algoritmo: o feed mostra só conteúdo de quem a pessoa segue ou com quem se conectou, em ordem cronológica (mais novo primeiro).
- Sem recomendações, sem aba explorar, sem rolagem infinita: o feed mostra as publicações das últimas 72 h (valor configurável) e termina no bloco "Você está em dia".
- Curtidas, comentários e notificações funcionam como nas redes comuns.
- Privacidade: no perfil aparecem só os NÚMEROS de conexões e de criadores seguidos. As listas de quem são essas pessoas nunca saem pela API para ninguém além do próprio dono.

## 2. Tipos de conta (regras aplicadas NO SERVIDOR, não só na interface)
- Conta pessoal (padrão): conecta-se com outras contas pessoais SOMENTE presencialmente, com conexão mútua (as duas pessoas confirmam); segue contas de criador à distância, buscando pelo @.
- Conta de criador: só publica; não segue ninguém e não se conecta com ninguém; pode ser seguida por contas pessoais.
- Busca: retorna apenas criadores, por prefixo do @ com no mínimo 3 caracteres, sem sugestões. Contas pessoais nunca aparecem na busca.
- Notificações de novos seguidores para criadores são agregadas e anônimas ("2 novas pessoas começaram a seguir você").

## 3. Conteúdo
Três tipos, cada um em uma aba separada, tanto no feed quanto no perfil:
- Fotos: 1 a 4 imagens com legenda.
- Textos: até 280 caracteres.
- Reels: vídeo vertical curto, sem reprodução automática do próximo vídeo.

## 4. Conexão presencial
NFC entre dois celulares NÃO é viável no iOS (o Core NFC só lê etiquetas; o modo de emulação de cartão é restrito pela Apple). Implementação:
1. O app pede ao backend um token de proximidade efêmero: opaco, com validade de 30 s, guardado no Redis.
2. Os dois apps, com a tela Conectar aberta, trocam esses tokens por Bluetooth Low Energy (react-native-ble-plx com config plugin do Expo).
3. A pessoa A envia o pedido com o token de B. B recebe o pedido e confirma. O servidor só cria a conexão se os dois tokens forem válidos, recentes e cruzados.
4. Plano B: QR code com o mesmo token efêmero.
5. Limitar tentativas por usuário e registrar o método usado (ble ou qr).
A interface "NFC / Bluetooth" do design fica, mas por baixo usa BLE. O Nearby Interaction (UWB) fica para uma versão futura.

## 5. Stack
- App: React Native + Expo (dev build, não Expo Go) + TypeScript strict + Expo Router.
- Backend: NestJS + Node.js + TypeScript, monólito modular (módulos: auth, users, connections, follows, posts, media, feed, comments, likes, notifications, proximity) + workers.
- Dados: PostgreSQL + Drizzle ORM (com migrations), Redis.
- Filas: Amazon SQS. Em desenvolvimento, LocalStack ou uma fila local com a mesma interface.
- Arquivos: S3 + CloudFront, com upload direto do app por URL pré-assinada.
- Vídeo: serviço gerenciado (AWS MediaConvert ou Mux), atrás de uma interface `VideoProcessor` para poder trocar depois. Nada de pipeline HLS próprio na v1.
- Push: Expo Push Notifications.
- Infraestrutura: Terraform para ECS/Fargate + RDS + ElastiCache + S3/CloudFront + SQS. Escrever o código, mas NÃO rodar `terraform apply`.
- Observabilidade: Sentry no app e na API desde o início. Pontos de OpenTelemetry preparados para depois.
- Monorepo: pnpm workspaces + Turborepo: `apps/mobile`, `apps/api`, `apps/worker`, `packages/shared` (tipos e schemas Zod compartilhados), `packages/ui` (componentes), `infra/terraform`, `docs/design`.
- Qualidade: ESLint + Prettier; testes com Vitest/Jest na API (incluindo testes das regras de permissão) e com Testing Library no app; `docker-compose` com Postgres, Redis e LocalStack para rodar tudo localmente.

## 6. Design (seguir com fidelidade)
Estilo: minimalista, disposição de elementos IGUAL à do Instagram para reduzir a curva de aprendizado. Interface em preto e branco; o azul aparece só em ações.

Tokens (`packages/ui/theme.ts`): blue #0066FF (ações, curtida ativa, seleção); blueMid #4D94FF; blueMist #B3D1FF; blueLight #E5EFFF; black #000000; grey #737373 (texto de apoio); greySoft #EFEFEF (botões neutros e campos); border #DBDBDB; white #FFFFFF.
Fontes: Inter (toda a interface) e Bricolage Grotesque 800 (apenas no logotipo "sussurro", em minúsculas).
Raios: botões e campos 10–12; folhas inferiores 20 no topo; avatares circulares. Barras de rolagem escondidas.

Logo: "S" de dois arcos com pontas arredondadas e um ponto no centro. viewBox 0 0 64 64, stroke-width 8:
- arco 1 (#0066FF): `M42.34 18.24 A11 11 0 1 0 24.22 29.78`
- arco 2 (#4D94FF): `M21.66 45.76 A11 11 0 1 0 39.78 34.22`
- ponto (#000000): cx 32, cy 32, r 3
- Sobre fundo azul ou preto: arcos em branco e #B3D1FF, ponto branco.
- Componente `<Logo variant="mark|lockup" />`, usado no ícone do app e na tela de abertura.

Componentes em `packages/ui`: Avatar (iniciais sobre fundo colorido sem foto), Button (primary azul, secondary cinza), Input, TopTabs (abas de texto com sublinhado; no perfil, abas com ícones), PostPhoto, PostText, ReelTile, ReelViewer, CommentsSheet, CaughtUp, ProfileHeader, StatsRow, BottomTabBar, Toast, EmptyState.

Telas e navegação:
- Barra inferior só com ícones, na ordem do Instagram. Pessoal: Início, Pesquisar, Criar (quadrado com +), Conectar, Perfil (foto com anel quando ativa). Criador: Notificações, Criar, Perfil. Ícone ativo preenchido ou mais grosso.
- Entrar/cadastrar: logo centralizado, campos cinza, botão azul "Entrar", rodapé "Não tem uma conta? Cadastre-se"; no cadastro, tipo de conta (Pessoal/Criador) como lista com botões de opção.
- Feed: logo à esquerda, coração de notificações à direita (ponto azul se não lidas); abas Fotos, Textos, Reels. Post de foto: cabeçalho (avatar, @, "Conexão" ou "Criador"); imagem 4:5 largura total, contador "1/3" e setas se várias; coração e comentário com pontos do carrossel centralizados na mesma linha; "N curtidas"; **@** + legenda; "Ver todos os N comentários"; "Há 18 minutos". Textos em formato thread (avatar, @, horário, texto, curtir, comentar). Reels em grade 3 colunas (9:16) com duração; toque abre tela cheia. Fim de cada aba: "Você está em dia" (círculo azul com check).
- Pesquisar: barra cinza "Pesquisar @criador", sem sugestões. Se digitar o @ de conta pessoal, explicar que contas pessoais só se conectam ao vivo.
- Conectar: seletor NFC/Bluetooth, botão azul circular "Procurar por perto"; radar com anéis animados; lista "Por perto agora" com "Conectar"; estados "Aguardando X confirmar" e "Conectados"; folha de pedido recebido (Aceitar/Recusar); bloqueada para criador.
- Perfil: cabeçalho com @ e, se próprio, botões Criar e Sair; avatar 86 à esquerda e números à direita (publicações, conexões, criadores; criador: publicações, seguidores); nome, tipo de conta, bio; botões: pessoal "Editar perfil" e "Conectar ao vivo"; criador visto por pessoa "Seguir" (azul)/"Seguindo" (cinza); próprio criador "Editar perfil" e "Nova publicação"; abas com ícones: grade de fotos (3 col, 3:4), lista de textos, grade de reels.
- Criar: barra inferior escondida; topo com X, título, "Compartilhar" azul; modo foto: prévia quadrada, legenda, "Recentes", grade 4 colunas com seleção numerada até 4; modo texto estilo thread com contador x/280; pílula escura flutuante FOTO/TEXTO/REEL; "Para suas N conexões" / "Para seus N seguidores".
- Notificações: grupos "Hoje" e "Esta semana"; linha com avatar, texto, horário, miniatura à direita.
- Comentários: folha inferior, título centralizado, lista, campo com "Publicar" em azul.

## 7. Modelo de dados (Drizzle)
- users: id, handle (único), name, bio, avatar_url, account_type (personal | creator), created_at
- connections: user_a_id, user_b_id (par ordenado, único), method (ble | qr), created_at
- connection_requests: from_id, to_id, status, expires_at
- follows: follower_id (somente personal), creator_id (somente creator), created_at
- posts: id, author_id, type (photo | text | reel), caption, text, created_at, deleted_at
- post_media: post_id, position, kind, storage_key, width, height, duration_s, status
- likes; comments; notifications (tipo e payload, mais agregações para criadores)
- Índices: posts(author_id, created_at desc), follows(follower_id), prefixo de users(handle).

## 8. Fases (parar ao fim de cada uma)
- Fase 0: monorepo, docker-compose, lint e testes rodando, CI básico, tema e componentes base em packages/ui com uma tela de catálogo dos componentes.
- Fase 1: autenticação (e-mail e senha com JWT e refresh), cadastro com tipo de conta, perfil próprio e edição.
- Fase 2: publicações de foto e texto, upload S3, feed cronológico com "Você está em dia", curtidas e comentários.
- Fase 3: busca de criadores, seguir/deixar de seguir, perfil de criador, testes de permissões (criador não segue; listas privadas).
- Fase 4: conexão presencial (tokens efêmeros, BLE, QR, confirmação mútua) e testes.
- Fase 5: reels (upload, processamento via VideoProcessor, grade e visualizador).
- Fase 6: notificações no app e push, e Sentry.
- Fase 7: Terraform (somente código) e documentação de deploy.
Critério de pronto em cada fase: testes passam, regras de permissão verificadas no servidor, app roda no iOS e Android (dev build), README atualizado.

## 9. Fora da v1
Mensagens diretas, stories, compartilhar post, salvar post, perfil público de contas pessoais, Nearby Interaction/UWB e qualquer forma de recomendação ou ranqueamento.
