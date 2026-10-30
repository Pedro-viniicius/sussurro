# Passagem de bastão: kickoff do Sussurro

> Atualizado em 2026-10-29, no fim da sessão 1, quando o PO precisou trocar de conta.
> **Nenhum código foi escrito.** O PO pediu que a equipe apresente o plano da Fase 0 e a estrutura de pastas antes de qualquer código, e que pare ao fim de cada fase para revisão.

## 1. Onde estamos

Estamos na Fase 2 do fluxo `/equipe-dev` (kickoff com os especialistas).

| Etapa | Status | Saída |
|---|---|---|
| Reconhecimento | ✅ Concluída | Protótipo lido (PDF de 22 páginas) e copiado para `docs/design/prototipo/` (PDF + `p-01.png`…`p-22.png` + `texto-extraido.txt`) |
| Briefing | ✅ Concluída | `docs/equipe/briefing.md`: especificação do PO transcrita na íntegra + decisões + notas do protótipo |
| 🏛️ Arquiteto | ✅ Concluída | `docs/equipe/arquitetura.md` + ADRs 0001 a 0011 em `docs/equipe/adr/` |
| 🎨 UX/UI | ✅ Concluída (sessão 2) | `docs/equipe/ux.md` |
| 💻 Dev | ✅ Concluída (sessão 2) | `docs/equipe/fase-0-plano.md` + `docs/equipe/backlog.md` |
| ⚙️ DevOps | ✅ Concluída (sessão 2) | `docs/equipe/infra.md` |
| 🧪 QA | ✅ Concluída (sessão 2) | `docs/equipe/testes.md` + critérios de aceite no `backlog.md` |
| Consolidação (coordenador) | ✅ Concluída (sessão 2) | `PROJETO.md` definitivo, `CLAUDE.md` completo, correções da seção 6 |
| Apresentar ao PO o plano da Fase 0 e a estrutura de pastas | ✅ Apresentado na sessão 2; aguardando aprovação | Resposta no chat + decisões pendentes |

> **Sessão 2 (2026-10-29):** os arquivos `ux.md`, `fase-0-plano.md`, `backlog.md` e `infra.md` **não existiam**. O UX/UI, o Dev e o DevOps foram reexecutados em paralelo com os prompts de `kickoff-prompts.md`. Os três terminaram (ux.md, fase-0-plano.md, backlog.md, infra.md existem). O QA foi disparado em seguida. Conflitos já vistos para a consolidação: pnpm 12.16.1 (Dev) × 12.13.0 (DevOps); Valkey no CI (DevOps) × Redis da especificação; rota do catálogo `/dev/catalog` (Dev) × `app/dev/catalogo.tsx` (UX); `DELETE /me` com senha e `profileVisible` por autor de comentário (UX → Arquiteto).

## 2. Como retomar (instruções para a próxima sessão)

1. **Confira os arquivos dos especialistas.** Os arquivos `ux.md`, `fase-0-plano.md`, `backlog.md` e `infra.md` podem estar **ausentes ou incompletos**, porque os agentes estavam escrevendo quando a sessão acabou. Confira se cada um existe e se tem todas as seções pedidas no prompt (veja `kickoff-prompts.md`). Se faltar algo, rode de novo o especialista correspondente (`ux-ui`, `dev`, `devops`) com o prompt **exato** de `kickoff-prompts.md`. Os três podem rodar em paralelo.
2. **Rode o 🧪 QA** com o prompt pronto em `kickoff-prompts.md` §4, depois que os três arquivos acima estiverem completos.
3. **Resolva os conflitos.** Se o QA ou a comparação entre os documentos apontar contradições, devolva cada ponto ao especialista responsável ou leve as opções ao PO.
4. **Consolide (é tarefa do coordenador):**
   - Reescreva `docs/equipe/PROJETO.md` com resumo, premissas, escopo do MVP, fora de escopo, roadmap das fases 0 a 7, riscos (vindos de `arquitetura.md` §16 + infra + QA), DoR e DoD.
   - Aplique as correções conhecidas da seção 6.
   - Complete o `CLAUDE.md` da raiz com a seção "Equipe e convenções": stack, comandos, padrões, commits e branches, link para `PROJETO.md`.
5. **Apresente ao PO** um resumo curto: o plano da Fase 0, a árvore de pastas, as decisões pendentes (seção 4) com a recomendação da equipe e as ações que ele precisa fazer (seção 5). **Pare e espere a aprovação.** Não faça scaffold, não instale pnpm/pacotes e não faça commit antes disso.

## 3. Decisões do PO já tomadas
- Código em `C:\dev\sussurro`, fora do OneDrive. O PDF original continua em `C:\Users\yasmi\OneDrive\Documents\projetos_web\`.
- Ferramentas instaladas via winget (feito).
- iOS: EAS Build + conta Apple Developer + iPhone físico.
- Stack fixada pelo PO na seção 5 do briefing. Qualquer desvio vira decisão do PO, nunca mudança silenciosa.

## 4. Decisões pendentes do PO (levar com a recomendação da equipe)

| # | Tema | Recomendação atual | Origem |
|---|---|---|---|
| D1 | **BLE**: substituir `react-native-ble-plx`, que não anuncia, por um módulo Expo próprio que anuncia e varre sem conexão | Módulo próprio, com o token de 12 bytes dentro de um UUID de serviço de 128 bits | ADR 0002 |
| D2 | **Emulação AWS local**: LocalStack, como o PO pediu (hoje exige token, e o plano grátis é só para uso não comercial) × ElasticMQ + SeaweedFS | ElasticMQ + SeaweedFS (o DevOps está confirmando a licença) | ADR 0010, `infra.md` |
| D3 | **Seletor "NFC / Bluetooth"** com BLE por baixo × "Bluetooth / QR code" (hoje o QR não aparece em nenhuma tela) | Aguardando o UX. O arquiteto e o coordenador tendem a "Bluetooth / QR code" | ADR 0002/0003, `ux.md` |
| D4 | **Sentry**: Fase 0 (a especificação diz "desde o início") × Fase 6 (está na lista da fase) | SDK inicializado na Fase 0 só quando houver DSN; o resto na Fase 6 | `fase-0-plano.md` |
| D5 | **Denunciar e bloquear** (a App Store exige em apps com conteúdo de usuários) | Incluir na v1, provavelmente em fase própria | `arquitetura.md` R8 |
| D6 | **Esqueci a senha / verificação de e-mail** (exige serviço de e-mail, ex.: SES) | A definir | Arquiteto |
| D7 | **QR cruzado**: B precisa ler o QR de A ou basta aceitar? | A definir | ADR 0003 |
| D8 | **Desfazer conexão** é permitido? | A definir | Arquiteto |
| D9 | Os **próprios posts** aparecem no próprio feed? | A definir | Arquiteto |
| D10 | **Limites de reel** | 90 s e 200 MB | ADR 0006 |
| D11 | **Visibilidade de comentários** (revela parte do grafo de conexões) | A definir | `arquitetura.md` R6 |
| D12 | **Região e volume**: sa-east-1; ~50 mil cadastrados e ~5 mil ativos/dia no 1º ano | Confirmar | `arquitetura.md` §1 |
| D13 | **Distância "a ~1 m"** × faixas ("bem perto" / "por perto") | Faixas | `arquitetura.md` §11.2 |
| D14 | **Login**: só e-mail × "e-mail ou nome de usuário" (como no protótipo) | Só e-mail | ADR 0007 |
| D15 | **Itens de demo do protótipo** ("Entrar na conta de criador (demo)", "Simular um pedido recebido") | Fora da v1; no máximo uma rota `/dev/*` que não vai para produção | Briefing |
| D16 | **CI**: GitHub Actions exige repositório no GitHub (ainda não há `git init` nem remoto) | GitHub Actions | `infra.md` |
| D17 | **Troca de tipo de conta** depois do cadastro | Não na v1 (o banco bloqueia por trigger) | ADR 0008 |

Também entram aqui as decisões que UX, Dev, DevOps e QA levantarem nos documentos deles.

## 5. Ações do PO fora do código
- [ ] **WSL2**: rodar `wsl --install` em um PowerShell **como administrador** e reiniciar. O Docker Desktop não sobe sem ele.
- [ ] Abrir o Docker Desktop uma vez depois do WSL e aceitar os termos.
- [ ] Contas: **Expo** (EAS Build), **Apple Developer** (US$ 99/ano), **GitHub** (repositório + Actions) e **Sentry** (se D4 = Fase 0).

## 6. Correções conhecidas a aplicar na consolidação
- `arquitetura.md` §3 ("pnpm via corepack") e §14, e o ADR 0001: **o Node 26 não traz o corepack** (foi removido a partir do Node 25). Fixar o pnpm em `packageManager` e instalar à parte (`npm i -g pnpm@<versão>` ou winget `pnpm.pnpm`). No CI, usar `pnpm/action-setup`. Seguir o que o DevOps definir no `infra.md`.
- A especificação do PO cita o LocalStack no docker-compose; o ADR 0010 diverge. Fica em "proposto" até o PO decidir (D2).
- Sentry: há contradição na própria especificação (D4).

## 7. Estado do ambiente (máquina do PO, Windows 11 Home)
- Node **v26.13.0** (LTS desde 28/10/2026), Git **2.56**, Docker Desktop **29.9.2** e Poppler **25.07**, todos via winget. Terminais abertos depois da instalação já têm o PATH certo.
- **pnpm não instalado.** **WSL2 não instalado** (o Docker não sobe).
- Não há Python, Android Studio nem Mac.
- **Git: repositório não inicializado.** Nada foi commitado; não commitar sem pedido explícito do PO.
- Para ler o PDF do protótipo de novo: `pdftoppm`/`pdftotext` (Poppler) já estão no PATH, mas os PNGs já estão em `docs/design/prototipo/`.

## 8. Achados do coordenador (para o PROJETO.md)
- `react-native-ble-plx` só atua como central e não anuncia. O iOS em primeiro plano só anuncia `LocalName` e UUIDs de serviço (até 28 bytes, sem service data), o que justifica o token dentro de um UUID de 128 bits (ADR 0002). BLE não funciona no simulador iOS: a Fase 4 exige dois aparelhos físicos, e o QR + uma rota `/dev` cobrem o teste individual.
- A App Store exige exclusão de conta (o arquiteto já colocou na Fase 1) e denúncia/bloqueio (D5).
- Divergências do protótipo em relação à especificação: botões de demo, login por usuário, avatares com fundo pastel (fora dos tokens) e distância em metros.
