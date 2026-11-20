# Sussurro: PROJETO

> Consolidado pelo coordenador em 2026-10-29, no fim do kickoff (`/equipe-dev`).
> **Status: aprovado pelo PO em 2026-10-29 ("Aprovado, faça até concluir tudo").** Todas as recomendações da equipe na §8 (8.1 e 8.2) passam a valer como decididas, e as fases seguem em sequência, sem parada intermediária para aprovação. O fim de cada fase é registrado na seção "Estado das fases" do `README.md`.
>
> Bloqueios de ambiente que só o PO resolve (os testes que dependem deles ficam marcados como pendentes até lá):
> - WSL2 e Docker (sem eles não há Postgres/Redis locais para os testes e2e);
> - LongPathsEnabled;
> - conta Apple e credenciais de push (dev builds EAS). (atualizado em 2026-10-31) GitHub e Expo resolvidos: o CI roda desde o PR #1, e o PO criou o projeto do EAS em 2026-10-30;
> - aparelhos físicos.
>
> **(atualizado em 2026-11-19)** O Conectar passou de Bluetooth para **NFC + QR code** (ADR 0013, PR #12 na `main`). As seções 1, 3, 6 e 7 foram alinhadas, e os próximos passos estão na §9.1. Também entraram o job `native` do CI (módulo NFC e manifesto de release) e o `expo` 58.0.26 (PR #13).

## 1. Resumo

O Sussurro é uma rede social **sem algoritmo**. O feed mostra só quem a pessoa segue ou com quem se conectou, em ordem cronológica, nas últimas 72 h, e termina em "Você está em dia". Há dois tipos de conta, com regras aplicadas no servidor:
- **Pessoal**: conecta-se com outra pessoa **só presencialmente**, com confirmação mútua (NFC ou QR code; desde 2026-11-14, ADR 0013, no lugar do BLE), e segue criadores à distância.
- **Criador**: só publica e pode ser seguido.

As listas de conexões e de seguidos **nunca saem pela API** para ninguém além do dono.

O app é Expo/React Native. A API e o worker são NestJS (monólito modular). Os dados ficam em PostgreSQL/Drizzle e Redis, as filas em SQS, a mídia em S3 + CloudFront, e o vídeo é processado pelo MediaConvert atrás de `VideoProcessor`. A infraestrutura é Terraform para ECS/Fargate. Tudo fica num monorepo pnpm + Turborepo.

## 2. Documentos

| Documento | Autor | Conteúdo |
|---|---|---|
| `briefing.md` | PO (transcrito) | Especificação original na íntegra e notas do protótipo |
| `arquitetura.md` + `adr/0001…0012` | 🏛️ Arquiteto | Visão, C4, modelo de dados, feed, mídia, auth, protocolo de proximidade, segurança, riscos |
| `ux.md` | 🎨 UX/UI | Personas, jornadas, rotas Expo Router, wireframes, estados, design system (`theme.ts`, componentes, ícones, fontes), acessibilidade |
| `fase-0-plano.md` | 💻 Dev | Escopo, árvore de pastas, ferramentas, scripts, convenções, tarefas e critério de pronto da Fase 0 |
| `backlog.md` | 💻 Dev + 🧪 QA | Épicos E0–E7 + EX, histórias, pontos e critérios de aceite Dado/Quando/Então |
| `infra.md` | ⚙️ DevOps | Pré-requisitos do Windows, docker-compose, CI, EAS, desenho AWS, observabilidade, custos |
| `testes.md` | 🧪 QA | Estratégia, casos críticos numerados, matriz de aparelhos, DoR/DoD, checklist da Fase 0, 43 ambiguidades |
| `HANDOFF.md` | Coordenador | Histórico do kickoff (sessões 1 e 2) |

Em caso de conflito, vale este arquivo, depois o documento do especialista responsável pelo tema.

## 3. Premissas

- **Volume do 1º ano**: ~50 mil cadastrados, ~5 mil ativos/dia e ~50 req/s de pico. Região `sa-east-1` (D12, a confirmar).
- **Máquina de dev**: Windows 11 Home com 7,7 GB de RAM, Node 26.13.0 LTS e pnpm 12.13.0 instalado à parte (o Node 26 não traz o corepack). Docker Desktop sobre WSL2, com WSL limitado a 3 GB. Sem Mac e sem Android Studio.
- **iOS**: sai só pelo EAS Build, com conta Apple Developer paga (US$ 99/ano) e iPhone físico. **NFC não funciona em simulador** (o BLE, que ele substituiu, também não): a Fase 4 exige aparelhos físicos. (atualizado em 2026-11-19) Mínimo proposto para a 4e: 2 Androids com HCE + 1 iPhone (`testes.md` 8.1), aguardando o PO.
- **Android**: dev build pelo EAS em aparelho físico. O emulador não é recomendado com 7,7 GB de RAM.
- **Ambientes**: local, CI e produção. Staging fica fora da v1.
- **AWS**: custo zero até o fim da Fase 7 (só código, **nunca `terraform apply`**).

## 4. Escopo do MVP (v1)

Tudo que está nas seções 1 a 7 da especificação (`briefing.md`), mais o que a equipe considera obrigatório para publicar:
- **Exclusão de conta no app**: a App Store exige (diretriz 5.1.1(v)). Entra na Fase 1.
- **Remoção de EXIF/GPS das fotos** (ADR 0009), na Fase 2.
- **Rate limit** em proximidade, auth e upload.

Itens que dependem do PO (seção 8): denunciar e bloquear (D5), esqueci a senha e verificação de e-mail (D6).

## 5. Fora do escopo da v1

Da especificação:
- mensagens diretas, stories, compartilhar post e salvar post;
- perfil público de contas pessoais;
- Nearby Interaction/UWB;
- qualquer recomendação ou ranqueamento.

Recomendação da equipe, confirmada pela aprovação do PO de 2026-10-29 (topo):
- troca de tipo de conta (D17);
- itens de demo do protótipo na interface de produção (D15);
- tema escuro, tablet e paisagem;
- staging;
- e2e automatizado no celular;
- pipeline HLS próprio.

## 6. Roadmap

Parar ao fim de cada fase para revisão do PO. Os pontos vêm de `backlog.md` (1 ponto ≈ 2 h de um dev; é ordem de grandeza, não prazo).

| Fase | Entrega | Pontos | Pré-requisitos do PO |
|---|---|---|---|
| **0** | Monorepo, docker-compose, lint e testes, CI básico, `theme.ts` e componentes base com a tela `/dev/catalog` | 44 (Dev: 74 h, ~89 h com reserva) | WSL2, pnpm, GitHub (CI), conta Expo; Apple para o iOS |
| 1 | Auth por e-mail e senha (JWT + refresh rotativo), cadastro com tipo de conta, perfil próprio, edição, exclusão de conta | 39 | D6, D14; `DELETE /me` com senha (A-15) |
| 2 | Fotos (1 a 4) e textos (280), upload S3, feed cronológico de 72 h, curtidas e comentários | 56 | D9, D11, A-06, A-08, A-09 |
| 3 | Busca de criadores, seguir, perfil de criador, canário de privacidade | 32 | A-04, D5 (se bloquear entrar, entra aqui) |
| 4 | Conexão presencial: tokens efêmeros, módulo nativo próprio (BLE até 2026-11-14; **NFC + QR** desde a ADR 0013), confirmação mútua | 63 | D1, D3, D7, D8, D13; aparelhos (A-03); **iOS obrigatório** |
| 5 | Reels: upload, `VideoProcessor`, grade e visualizador | 30 | D10, A-21 |
| 6 | Notificações no app, push (Expo) e Sentry completo | 27 | conta Sentry, APNs via EAS |
| 7 | Terraform (só código) e documentação de deploy | 36 | D12 |
| **Total** | | **327** (≈ 650 h) + até 26 de itens EX | |

## 7. Riscos principais

| # | Risco | Mitigação | Origem |
|---|---|---|---|
| R1 | O módulo nativo próprio (Swift/Kotlin) é código novo, e o NFC/HCE varia por fabricante Android; o iPhone só lê (não emite) | (atualizado em 2026-11-19, ADR 0013) QR sempre disponível; Kotlin com testes de JVM (NFC-10 a 17) no job `native` do CI; manifesto de release conferido no CI; roteiros MAN-NFC-01 a 04 em aparelho. O Swift ainda não foi compilado (sem Mac; sai pelo EAS) | ADR 0002, A-20 |
| R2 | Node 26 (LTS desde 28/10), Expo SDK 58 e React 19.3 são recentes | Portão de smoke test no início da Fase 0; fallback Node 24 / SDK 57 | ADR 0001 |
| R3 | O pnpm isolado pode quebrar o Metro ou o autolinking | Fallback `nodeLinker: hoisted` | `fase-0-plano.md` §9 |
| R4 | Não há conta Apple nem aparelhos confirmados | Fases 0 a 3 com "pendência iOS" se o PO aceitar; a Fase 4 não fecha sem iOS | A-02, A-03 |
| R5 | A App Store exige denunciar e bloquear | Decidir D5 antes da Fase 3 | R8 da arquitetura |
| R6 | Vazamento indireto do grafo social (comentários, cadastro, follow) | Respostas 404 idênticas, canário PERM-10, decisão D11 | ADR 0004, A-05, A-07 |
| R7 | Os emuladores S3/SQS não reproduzem expiração de presign nem `Content-Length` | Verificar no spike da Fase 0 (F0-DC-07); senão, a verificação real fica para depois do `apply` | A-22 |
| R8 | Pouca RAM (7,7 GB) para Docker + Metro + IDE | WSL limitado a 3 GB, sem emulador Android, ElasticMQ + SeaweedFS (leves) | `infra.md` |
| R9 | Custo de vídeo (MediaConvert + entrega) | Limites de 90 s / 200 MB, rate limit, budget alarm, CloudFront de preço fixo | ADR 0006, `infra.md` §9 |
| R10 | Rate limit do `resolve` estoura em lugares cheios | `resolve` em lote. (atualizado em 2026-11-19) Com NFC e QR, cada leitura é deliberada (um código por vez), e o risco cai bastante; o MAN-BLE-04 ficou obsoleto | A-17 |

Lista completa: `arquitetura.md` §16, `infra.md` §10 e `testes.md` §11.

## 8. Decisões do PO

### 8.1 Necessárias para começar a Fase 0

| # | Decisão | Recomendação da equipe |
|---|---|---|
| D2 | Emulação AWS local: LocalStack (pedido na especificação; exige conta e token desde mar/2026, plano grátis só para uso não comercial, plano Base a US$ 39–45 por dev/mês) × ElasticMQ + SeaweedFS | **ElasticMQ + SeaweedFS** (grátis, leves; o código só muda o `AWS_ENDPOINT_URL`) |
| D4 | Sentry na Fase 0 ("desde o início") × Fase 6 (lista da fase) | **SDK inicializado na Fase 0 só quando houver DSN**; sem DSN, nada é enviado. O resto fica na Fase 6 |
| D16 | CI no GitHub Actions; o repositório precisa existir | **GitHub Actions, repositório privado**. O GitHub Pro (US$ 4/mês) habilita a proteção da `main` |
| A-23 | "Componentes base" da Fase 0 | **11 componentes sem dados de domínio** (Logo, Icon, Avatar, Button, Input, TopTabs, BottomTabBar, Toast, EmptyState, CaughtUp, StatsRow); PostPhoto, PostText, ReelTile, ReelViewer, CommentsSheet e ProfileHeader nas fases que os usam |
| A-02 | Critério "roda no iOS" sem conta Apple | Aceitar **"aprovada com pendência iOS"** nas Fases 0 a 3; conta criada até o fim da Fase 3 |
| N1 | Identificador do app (bundle id / applicationId), conta Expo dona do projeto, conta Apple PF ou PJ | Sugestão: `app.sussurro` (definitivo depois de publicar) |
| N2 | Redis local e na AWS: **Valkey** (fork open source compatível com o protocolo Redis; mais barato no ElastiCache) | **Valkey**. A interface no código continua sendo Redis (`ioredis`). Se o PO preferir, troca-se pela imagem `redis` sem mudar código |

### 8.2 Necessárias antes de fases futuras

| # | Tema | Recomendação | Até |
|---|---|---|---|
| D14 | Login com e-mail × e-mail ou @ | Só e-mail | Fase 1 |
| D6 | Esqueci a senha / verificação de e-mail (exige SES) | Incluir os dois antes do lançamento | Fase 1 |
| A-13/14/15 | Exclusão de conta: comentários e curtidas somem na hora? @ reutilizável? Pede senha? | Somem na hora; @ nunca reutilizado; pede senha | Fase 1 |
| D17 | Troca de tipo de conta | Não na v1 | Fase 1 |
| D15 | Itens de demo do protótipo | Fora da UI; só rotas `/dev` em dev | Fase 1 |
| D9 | Os próprios posts no próprio feed | Sim | Fase 2 |
| D11 / A-07 | Comentários visíveis a quem vê o post (expõe o @ de quem comenta) | Visíveis; o @ só é tocável se o perfil for visível (`profileVisible`) | Fase 2 |
| A-06 | O criador comenta ou curte? | Responde e apaga comentários nos próprios posts; não curte nem comenta em posts de outros | Fase 2 |
| A-09 | Contagem dos 280 caracteres | Code points depois de NFC (emoji composto conta como vários) | Fase 2 |
| A-08 | Feed da Fase 2 demonstrado com dados de seed | Sim | Fase 2 |
| A-04 | Busca pelo @ de conta pessoal | Dica genérica sempre que não houver criador (não confirma que a conta existe) | Fase 3 |
| D5 | Denunciar e bloquear | Incluir; bloquear até a Fase 3 | Fase 3 |
| D3 | Seletor "NFC / Bluetooth" | **"Bluetooth / QR code"**: rotular "NFC" o que não usa NFC engana o usuário, e o QR precisa de lugar na tela. **Revisado pelo PO em 2026-10-30:** "encostar os celulares" (Bluetooth de curtíssimo alcance, só com a tela Conectar aberta nos dois), com o QR de reserva. O NFC foi descartado porque o iPhone não deixa um app social emular cartão NFC (iPhone ↔ iPhone não funcionaria). Motivo: quem está a alguns metros não deve nem enxergar a pessoa. Desenho aprovado pelo PO em 2026-10-30, com todas as recomendações: ADR 0012 (observação mútua no servidor, tokens separados para Bluetooth e QR, QR de reserva) e `ux.md` §11 (D-UX21 a D-UX24, textos T1 a T42, `expo-haptics` sujeito ao aval do `seguranca`, remoção do `Radar`). O gesto sai do spike 4.1-B em aparelho, por causa do NameDrop. O PO vai criar a conta Apple Developer para o build de iOS **Revisado de novo pelo PO em 2026-11-14:** sem Bluetooth; **NFC + QR code** (ADR 0013). O Android emite e lê por NFC, o iPhone só lê, e o QR fica sempre disponível. | Fase 4 (revisão pós-MVP) |
| D1 | BLE: `react-native-ble-plx` não anuncia | Módulo Expo próprio, com token num UUID de 128 bits. **Histórico:** o BLE saiu na ADR 0013 (2026-11-14); o módulo próprio agora faz NFC | Fase 4 |
| D7 | QR cruzado | B lê o QR de A (garante presença) | Fase 4 |
| D8 | Desfazer conexão | Permitido | Fase 4 |
| D13 | "a ~1 m" | Faixas: "bem perto" / "por perto". **Substituído pela revisão do D3 (2026-10-30):** só aparece quem está com o celular encostado | Fase 4 |
| A-03 / A-36 | Aparelhos e SO mínimo | Confirmar o inventário; SO mínimo do Expo SDK 58 | Fase 4 |
| D10 | Limites de reel | 90 s e 200 MB | Fase 5 |
| A-21 | GPS em vídeo só verificável depois do `apply` | Aceitar como "verificação pós-apply" | Fase 5 |
| D12 | Região e volume | `sa-east-1`; lançamento enxuto (~US$ 155/mês) × completo (~US$ 285/mês) | Fase 7 |
| L1 | Controlador e encarregado (DPO) na Política de Privacidade | Definir antes de publicar nas lojas | Lançamento |
| L2 | Idade mínima / ECA Digital (Lei 15.211/2025, em vigor desde 17/03/2026: contas de menores de 16 anos em redes sociais vinculadas a um responsável) | Decisão do PO com orientação jurídica. Se exigir idade ou vínculo, muda o cadastro da Fase 1 e a política | Antes do lançamento |
| L3 | Guarda de registros de acesso (Marco Civil, art. 15) | Hoje não prevista na arquitetura. Se o PO confirmar, entra na Fase 7 (logs de acesso com retenção e acesso restrito) e na política | Fase 7 |
| R1-PO-1 e A3-PO-2 | Fase 4d: denunciar quem você bloqueou (ADR 0012, Adendo A3; `ux.md` §11.16) | **Decidido pelo PO em 2026-10-31, as três recomendações:** (1) "Denunciar" também na tela "Contas bloqueadas", e a Política fica com a frase da R1-PO-1 que cita a lista; (2) os textos T47 e T48 aprovados como estão; (3) o cartão Bloqueado sem prazo continua com o nome e a foto até "Voltar". O texto da Política (A3-PO-1) sai só depois do deploy | Fase 4d (PR seguinte ao #3) |

L1 a L3 foram levantados em 2026-10-29 pela sessão que publicou o site público (`https://sussurro-site.vercel.app`: `/privacidade`, `/termos`, `/excluir-conta`; código em `C:\dev\sussurro-site`, fora deste repositório). Os textos legais são versão preliminar. **A política descreve o tratamento de dados da arquitetura** (retenção, operadores AWS/Expo/Sentry, remoção de EXIF e GPS, comentários visíveis pelo D11, permissões BLE, @ aposentado): qualquer fase que mude um desses pontos precisa atualizar `src/privacidade.html` daquele projeto.

Divergências visuais do protótipo, com recomendação do UX (`ux.md` §9):
- "Você está em dia" com círculo de contorno, como no p-08;
- prévia do Criar em 4:5;
- Conectar ativo em azul;
- splash proposta a partir do p-04.

## 9. Ações do PO fora do código

- [ ] PowerShell **como administrador**: `wsl --install --no-distribution`, ativar o LongPathsEnabled e reiniciar (`infra.md` §1.1).
- [ ] Criar `%UserProfile%\.wslconfig` com `memory=3GB`, abrir o Docker Desktop e aceitar os termos.
- [x] Instalar o pnpm: `npm i -g pnpm@12.13.0`. Configurar o Git: `git config --global core.longpaths true` e `git config --global core.autocrlf false`. (conferido em 2026-10-31)
- [ ] Firewall: liberar as portas 3000, 8081 e 8333 na rede Privada e marcar o Wi-Fi de casa como Privada (para o celular alcançar o PC).
- [ ] Contas: **Apple Developer** (US$ 99/ano; pode demorar dias para aprovar). O Sentry pode esperar (D4). (atualizado em 2026-10-31) **GitHub** e **Expo** feitos: o CI roda desde o PR #1, e o projeto do EAS existe desde 2026-10-30.
- [ ] Informar os aparelhos disponíveis (iPhones e Androids, com versões de SO).

### 9.1 Próximos passos (atualizado em 2026-11-20)

Na `main` desde 2026-11-20:
- Fase 4d portada (PR #21; o MÉDIO de segurança da 4d está fechado);
- S5 e `ux.md` §12 (b) e (c) (PR #22);
- Dependabot em dia (#16 a #20).

O código e o CI estão prontos, e o que falta depende do PO (contas, aparelhos, site). Em ordem:

| # | Passo | Por quê | Quem | Referência |
|---|---|---|---|---|
| 1 | Publicar no site a Política de Privacidade nova (NFC + QR, sem Bluetooth nem localização) | A página publicada ainda descreve o Bluetooth; política divergente do app é motivo de rejeição nas lojas | PO (repositório do site) | `docs/deploy/politica-privacidade-nfc.md` |
| 2 | Dev build EAS do iOS | O Swift do módulo NFC nunca foi compilado. O Android já tem build (2026-11-20, commit `80c3236`, com a 4d, o S5 e o §12). No iOS, o build não interativo falhou por falta de credenciais | PO (`! cd apps/mobile && pnpm eas build --profile development --platform ios`, login Apple) | README, Fase 4e |
| 3 | Roteiros em aparelho: MAN-NFC-01 a 04, MAN-QR-01, MAN-CON-01, MAN-A11Y-01 (QR carregando, S5) e MAN-A11Y-02 (foco depois do recarregamento do Início, Toasts do "Processando") | Validar o NFC de verdade (HCE por fabricante, gesto do iPhone) e o leitor de tela (VoiceOver e TalkBack) | PO + `testes` | `testes.md` §8; matriz mínima na §3; `ux.md` §12.7 |
| 4 | Conferir o AAB final (`bundletool dump manifest`) | O CI confere o manifesto do prebuild; o AAB do EAS tem a configuração e os segredos de produção. **Feito em 2026-11-20** (build `3e174add`): permissões ok; dois achados (o backup do login guardado e a versão `0.0.0`) corrigidos no PR da branch `fix/aab-backup-versao`. Falta refazer no próximo AAB | `devops` (Tech Lead) | `lojas.md`, "Permissões" |
| 5 | Fechar a Fase 4 e criar a tag `fase-4` | Depois dos passos 2 a 4 verdes | PO | `CLAUDE.md`, convenções |

Dívidas registradas, sem bloquear a tag:
- O BAIXO do `seguranca` no PR #22 (`frontend`): ao sair da conta, uma consulta em série pode sair sem token, e o aviso "sessão expirou" aparece logo depois de um "Sair" voluntário. Nada vaza.
- Sem rate limit global nos GET autenticados da API (`backend`, passada de hardening).

## 10. Definition of Ready e Definition of Done

Resumo de `testes.md` §9. A versão completa e a tabela por fase estão lá.

**DoR (uma história entra em desenvolvimento quando):**
- tem critérios de aceite Dado/Quando/Então;
- não depende de decisão 🔶 pendente;
- tem contrato da API esboçado;
- tem tela e estados no `ux.md`;
- tem dados de teste definidos;
- as dependências foram entregues;
- a estimativa cabe na fase.

**DoD (critério do PO, tornado verificável):**
1. **Testes passam**: `pnpm check` e `pnpm test:e2e` verdes, local e no CI. A história traz testes novos, com o ID do caso no nome, e não derruba a cobertura.
2. **Permissões verificadas no servidor**: os casos PERM/PROX/FEED da história estão verdes, e o canário PERM-10 está verde a partir da Fase 3. Toda rota nova entra no canário.
3. **Roda no iOS e no Android (dev build)**:
   - os roteiros manuais MAN-* foram executados em aparelho;
   - a evidência ficou na seção "Estado das fases" do README (SHA, CI, IDs dos builds EAS, aparelhos);
   - os prints ficam em `docs/evidencias/fase-N/`.
4. **README atualizado.**
5. O PR teve revisão, segue Conventional Commits e o gitleaks está verde.
6. O PO aceitou a demonstração.

## 11. Padronizações feitas na consolidação

- **pnpm 12.13.0** em todos os documentos. O DevOps escolheu a versão com mais de duas semanas de uso, como margem contra versões comprometidas na cadeia de suprimentos (A-01).
- **Correção do corepack**: `arquitetura.md` §3 e §14, ADR 0001 e `briefing.md` agora dizem "pnpm instalado à parte", com `pnpm/action-setup` no CI.
- **Nomes únicos** (A-25):
  - rota `/dev/catalog` em `apps/mobile/src/app/`;
  - variável `EXPO_PUBLIC_DEV_TOOLS`;
  - Inter só com os pesos 400/600/700;
  - um `.env.example` na raiz (compose, API e worker, porta em `API_PORT`) e outro no app (`EXPO_PUBLIC_*`).
- **CI**: o job `test` roda `pnpm test` e `pnpm test:e2e`; as migrations entram só a partir da Fase 1 (A-24).

### Pendências técnicas para o Arquiteto (antes da Fase 1/2, não bloqueiam a Fase 0)

(atualizado em 2026-10-31) Todas resolvidas nas Fases 1 a 4, conforme conferido pelo `arquiteto` no inventário de fechamento (por exemplo, A-28 em `packages/shared/src/auth.ts`).

- A-11: o CTE do feed, os contadores e as listas devem filtrar `users.deleted_at`.
- A-12: o hard delete precisa recalcular `like_count`/`comment_count`.
- A-15: `DELETE /me` recebe a senha (se o PO aprovar).
- `profileVisible` por autor de comentário (pedido do UX).
- A-27: `Clock` injetável e TTLs por config.
- A-28: senha com no máximo 128 caracteres e normalizada em NFC antes do hash.
- A-10, A-16, A-17, A-18: ajustes no protocolo de proximidade.
- A-31: rate limit na busca.
