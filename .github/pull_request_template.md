<!-- Título do PR em Conventional Commits, em pt-BR: tipo(escopo): descrição no imperativo.
     Ex.: feat(api): adiciona verificação de Redis no /health/ready
     Ele vira a mensagem do squash merge. Meta: menos de ~400 linhas alteradas (sem lockfile e assets). -->

## O que e por quê

<!-- Resumo da mudança e link para a história do docs/equipe/backlog.md (ex.: 0.4). -->

## Como testar

```powershell
pnpm check
pnpm test:e2e   # com docker compose up -d --wait
```

<!-- Passos extras (rotas, telas, roteiros MAN-*). -->

## Checklist (Definition of Done, `docs/equipe/PROJETO.md` §10)

<!-- Marque o que se aplica. Item que não se aplica: risque (~~texto~~) e diga por quê. -->

**Testes e revisão**

- [ ] Testes novos ou alterados, com o ID do caso do `testes.md` no nome
- [ ] `pnpm check` e `pnpm test:e2e` verdes localmente
- [ ] CI verde: `secrets` (gitleaks), `quality`, `test` e `build`
- [ ] A cobertura não caiu
- [ ] PR revisado; título em Conventional Commits (o CI confere)

**Servidor e contrato**

- [ ] Regras de permissão verificadas no servidor, com teste (casos PERM/PROX/FEED da história)
- [ ] Rota nova incluída no canário PERM-10 (a partir da Fase 3)
- [ ] Contrato em `packages/shared` atualizado (quando a API mudou)

**App e documentação**

- [ ] Capturas de tela de iOS e Android (quando houver UI)
- [ ] Roteiros MAN-\* executados em aparelho com dev build (quando houver UI ou código nativo)
- [ ] README e `docs/equipe` atualizados (quando aplicável)
- [ ] Sem segredos no diff (só `.env.example` com valores fictícios)

**Fechamento de fase** (só no PR que encerra a fase)

- [ ] Seção "Estado das fases" do README com SHA, link do CI, IDs dos builds EAS e aparelhos
- [ ] Prints em `docs/evidencias/fase-N/`
- [ ] Demonstração aceita pelo PO
