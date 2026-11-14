# Envio às lojas: perfis do EAS, `eas submit` e checklist da App Store e da Google Play

> Fase 7 (backlog 7.8). Autor: DevOps, 2026-10-30. **Nada foi enviado**: depende das contas (Apple, Google Play, Expo), do domínio e da produção no ar (runbook, passos 1 a 8).
> Os textos de propósito abaixo são copiados do código (`apps/mobile/app.config.ts` e `apps/mobile/modules/sussurro-proximity/app.plugin.js`, mais o `AndroidManifest.xml` do módulo). Mudou lá, atualize aqui.
> Desde a Fase 4e (ADR 0013), o Conectar usa **NFC + QR code**, sem Bluetooth e sem localização. O Android emite o código por HCE (Type 4 Tag) só com a tela Conectar aberta, em primeiro plano e desbloqueado, por até 30 s por código, e lê em reader mode. O iPhone só lê (`NFCNDEFReaderSession`) e mostra o QR para ser lido.

## 1. Perfis do `eas.json`

| Perfil | Para quê | Distribuição | API |
|---|---|---|---|
| `development` | Dev client; o JS vem do Metro do PC | interna (APK / iPhone registrado) | `.env` do `apps/mobile` |
| `preview` | Homologação de um build "de verdade" | interna (APK / ad hoc) | produção (`EXPO_PUBLIC_API_URL` do EAS) |
| `production` | Lojas | `store`: AAB no Android, IPA da App Store | produção |

`production`: versão do app gerida pelo EAS (`appVersionSource: remote`) com `autoIncrement` do build number, canal `production`, `APP_VARIANT=production` (bundle id `app.sussurro`, nome "Sussurro", sem exceções de rede local, `aps-environment` de produção).

`submit.production`:
- **Android**: trilha `internal` e `releaseStatus: draft`. Nada vai a público sem a promoção à mão no Play Console.
- **iOS**: vai para o App Store Connect (TestFlight). A publicação na App Store é manual. Depois do primeiro envio, acrescente o `ascAppId` (o "Apple ID" numérico do app no App Store Connect; não é segredo) em `submit.production.ios` para o `eas submit` rodar sem perguntas.

Credenciais (todas no EAS, nunca no repositório): certificado e perfis da Apple e keystore do Android gerados pelo EAS; chave APNs (push iOS); `google-services.json` (variável de arquivo `GOOGLE_SERVICES_JSON`) e a conta de serviço do FCM v1 (push Android); chave da API do App Store Connect (envio iOS); chave JSON de uma conta de serviço do Google Cloud com acesso ao Play Console (envio Android). Faça backup do keystore do Android (`eas credentials -p android` → download) no gerenciador de senhas do PO.

## 2. Comandos

```bash
pnpm --filter @sussurro/mobile eas build --profile production --platform ios
pnpm --filter @sussurro/mobile eas build --profile production --platform android
pnpm --filter @sussurro/mobile eas submit --platform ios --profile production --latest      # TestFlight
pnpm --filter @sussurro/mobile eas submit --platform android --profile production --latest  # trilha internal, rascunho
```

- **Android, primeira vez**: o Google exige que o **primeiro** AAB seja enviado à mão pelo Play Console (Testes → Teste interno → Criar versão). Baixe o AAB do build do EAS e envie. Depois disso, o `eas submit` funciona.
- **Conta pessoal nova no Google Play**: antes de produção, teste fechado com **12 testadores por 14 dias** (infra.md §1.5; confirme a regra vigente no Play Console). Entra no cronograma.
- **iOS**: o primeiro `eas submit` pergunta pela chave da API do App Store Connect (crie em Users and Access → Integrations, papel App Manager) e a guarda no EAS.

## 3. Checklist da App Store (App Store Connect)

**Conta e privacidade**
- [ ] **Exclusão de conta no app** (diretriz 5.1.1(v)): Conta → "Excluir conta", com senha (Fase 1); a conta some na hora e é apagada em até 30 dias. Na nota ao revisor, diga onde fica.
- [ ] **Política de Privacidade**: URL no App Store Connect (`https://sussurro-site.vercel.app/privacidade`, ou a do domínio definitivo) e o link no app (Cadastro e Conta, `apps/mobile/src/lib/legal.ts`). Antes de enviar, a política precisa estar atualizada com as Fases 5, 6 e 7 (pendências registradas no README) e com o controlador e o encarregado (L1). Sobre o Conectar, ela deve dizer que o app usa o **NFC, só com a tela Conectar aberta** (para trocar o código de conexão entre dois celulares encostados), ou a câmera para o QR code. Nada de Bluetooth nem de localização: se o texto publicado ainda citar "Bluetooth" ou "localização para achar pessoas perto", corrija antes de enviar.
- [ ] **Termos de uso** com tolerância zero a conteúdo abusivo (diretriz 1.2), aceitos no cadastro (rodapé do Cadastro com o link). Conferir com o jurídico se o texto de `/termos` diz isso explicitamente.
- [ ] **Privacidade do app** ("App Privacy", rótulos):
  - Coletados e ligados à pessoa, para funcionamento do app: e-mail (Contact Info); fotos, vídeos, textos e comentários (User Content); id da conta (Identifiers → User ID); token de push do aparelho (Identifiers → Device ID).
  - Diagnóstico (Sentry, se ligado): Crash Data e Performance Data, **não ligados** à pessoa (sem `setUser`, sem PII, `sendDefaultPii: false`).
  - **Não coletados**: localização (o GPS sai das fotos e dos vídeos; o app não usa Bluetooth nem localização, e o NFC só troca o código de conexão com o celular encostado, com a tela Conectar aberta), contatos, histórico de navegação, dados de compra.
  - **Rastreamento: não** (sem anúncios nem SDK de terceiros que rastreie). Sem App Tracking Transparency.
- [ ] **Manifesto de privacidade** (`PrivacyInfo.xcprivacy`): o Expo SDK 58 junta os dos módulos. Depois do build, confira no relatório de privacidade do Xcode/Transporter ou no e-mail do App Store Connect se falta alguma "required reason API"; se faltar, acrescentar em `ios.privacyManifests` (mudança de config do app).

**Conteúdo gerado por usuários (diretriz 1.2)**
- [ ] Denunciar post, comentário e conta (X.1, D5) e bloquear conta (X.2): existem desde a Fase 3. Diga onde ficam na nota ao revisor.
- [ ] Moderação: cada denúncia chega no `MODERATION_EMAIL`. Prazo de resposta (ex.: 24 h) definido pelo PO e escrito nos Termos.
- [ ] Contato publicado (e-mail de suporte ou página) no App Store Connect (Support URL).
- [ ] Risco: a 1.2 também pede "um método para filtrar conteúdo impróprio antes da publicação". Hoje não há filtro automático; a defesa é o modelo sem algoritmo (só conexões e criadores seguidos) + denúncia + bloqueio + moderação. Se o revisor pedir, é decisão do PO (ex.: lista de termos bloqueados).

**Permissões e textos de propósito (Info.plist)**

| Chave | Texto (pt-BR) | Quando aparece |
|---|---|---|
| `NFCReaderUsageDescription` | "O Sussurro usa o NFC só para ler o código de conexão de outra pessoa quando você aproxima os celulares, com a tela Conectar aberta." | Ao tocar para ler por NFC na tela Conectar (abre a folha do sistema: "Aproxime o topo do iPhone das costas do outro celular.") |
| `NSCameraUsageDescription` | "O Sussurro usa a câmera só para ler o QR code de outra pessoa na tela Conectar. Nada é fotografado nem gravado." | Ler o QR code |
| `NSPhotoLibraryUsageDescription` | "O Sussurro abre as fotos e os vídeos que você escolher para publicar ou usar como foto de perfil. A localização das fotos é removida antes de publicar." | O seletor do sistema não pede acesso à biblioteca inteira; a chave existe porque o módulo a referencia |
| Notificações | Sem texto no Info.plist. Pedido contextual antes do diálogo do sistema: "Quer saber quando alguém curtir ou comentar?" [Agora não] [Ativar] | Depois do primeiro post ou da primeira conexão (6.4) |

- [ ] Sem microfone (`NSMicrophoneUsageDescription` removido pelos plugins), sem localização no iOS, sem `NSBluetoothAlwaysUsageDescription` nem `NSBluetoothPeripheralUsageDescription` (o plugin do módulo as remove) e sem `UIBackgroundModes` (nada roda com o app fechado; o push é remoto). Confira no `Info.plist` do IPA.
- [ ] **Entitlement de NFC**: `com.apple.developer.nfc.readersession.formats` = `["TAG"]` (o plugin do módulo o escreve; a Apple recusa `NDEF` desde o SDK do iOS 13, ITMS-90778). A capability "NFC Tag Reading" precisa estar ligada no App ID; o EAS sincroniza as capabilities ao gerar o perfil. Confira os entitlements no log do build do EAS ou com `codesign -d --entitlements - Sussurro.app`.
- [ ] `NSLocalNetworkUsageDescription` e `NSAllowsLocalNetworking` **não** podem estar no build de produção (só no `development`; teste F0-APP-05).

**Envio**
- [ ] Conformidade de exportação: o app só usa a criptografia padrão do sistema (HTTPS) → isento. Responda no App Store Connect a cada build, ou (recomendado, mudança de config do app) `ios.config.usesNonExemptEncryption: false`.
- [ ] Sign in with Apple: não exigido (login só por e-mail e senha, sem login social).
- [ ] Classificação etária: conteúdo gerado por usuários, interação entre pessoas. Depende do L2 (ECA Digital: menores de 16 anos vinculados a um responsável), decisão do PO com o jurídico.
- [ ] Conta de demonstração para o revisor (duas contas pessoais já conectadas e uma de criador, com posts) e nota: "Conectar" troca um código entre dois aparelhos com a tela aberta. O iPhone lê por NFC o código de um Android encostado (o iPhone não emite por NFC) ou usa o QR code; sem dois aparelhos, use o QR code (um aparelho mostra, o outro lê). Um vídeo curto do Conectar ajuda a revisão.
- [ ] Capturas de tela (iPhone 6,9" e 6,5"), ícone de 1024 px (de `apps/mobile/assets`), descrição, palavras-chave, categoria Redes Sociais, URL de suporte, copyright, pessoa física ou jurídica (P6).
- [ ] Push: chave APNs no EAS e MAN-PUSH-01 passando no build do TestFlight.

## 4. Checklist da Google Play (Play Console)

**Conta e dados**
- [ ] **Exclusão de conta**: no app (Conta → Excluir conta) **e** por uma URL na web, exigida pelo Google: `https://sussurro-site.vercel.app/excluir-conta`.
- [ ] **Política de Privacidade**: a mesma URL do iOS, no Play Console e no app.
- [ ] **Segurança dos dados** (Data safety): os mesmos dados do iOS (e-mail, conteúdo, id da conta, token de push; diagnóstico se o Sentry estiver ligado); criptografados em trânsito; a pessoa pode pedir a exclusão; **nenhum dado compartilhado** com terceiros para anúncios; localização **não coletada**.
- [ ] Público-alvo e conteúdo: faixa etária conforme o L2; questionário IARC (interação entre usuários, conteúdo gerado por usuários); sem anúncios; não é app de governo, saúde, notícias nem para crianças.

**Permissões** (conferir no AAB final: `bundletool dump manifest --bundle=app.aab` ou o Play Console → App bundle explorer)

| Permissão | Por quê | Observação |
|---|---|---|
| `android.permission.NFC` | Trocar o código de conexão encostando os celulares, só com a tela Conectar aberta | Permissão normal (sem pedido na tela). Vem do manifesto do módulo e o plugin a repete no do app |
| `uses-feature android.hardware.nfc` e `android.hardware.nfc.hce` (`required=false`) | Ler (reader mode) e emitir o código (HCE, Type 4 Tag) | Opcionais na loja: aparelho sem NFC instala e fica com o QR code |
| Serviço HCE `SussurroNdefService` (`BIND_NFC_SERVICE`, `requireDeviceUnlock=true`) | Emite o código só com o aparelho desbloqueado e a tela Conectar aberta, por até 30 s por código | `exported=true` só para o sistema, como o HCE exige; não é permissão pedida à pessoa |
| Bluetooth (`BLUETOOTH*`) e localização (`ACCESS_*_LOCATION`) | **Removidas** (ADR 0013) | O plugin do módulo as tira com `tools:node="remove"`, inclusive se uma dependência as trouxer pelo merge. Confira que não aparecem no AAB |
| `CAMERA` | Ler o QR code | Texto de propósito igual ao do iOS |
| `POST_NOTIFICATIONS` | Push (Android 13+), pedido contextual | Canal "Notificações" |
| `com.google.android.c2dm.permission.RECEIVE`, `WAKE_LOCK` | Do FCM (push remoto) | Vêm da biblioteca |
| `RECEIVE_BOOT_COMPLETED` | **Removida** (o app não agenda notificações locais) | `blockedPermissions` no `app.config.ts` |

- [ ] **Fotos e vídeos**: o app usa o seletor do sistema (Photo Picker). Se o AAB final tiver `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO` ou `READ_EXTERNAL_STORAGE` (vindas de alguma biblioteca), o Google exige uma declaração e tende a recusar quem só escolhe mídia de vez em quando: nesse caso, bloquear essas permissões no `app.config.ts` (`android.blockedPermissions`) antes de enviar.
- [ ] Sem `FOREGROUND_SERVICE`, sem `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION`/`ACCESS_BACKGROUND_LOCATION`, sem `BLUETOOTH*`, sem `RECORD_AUDIO` (o microfone é bloqueado pelos plugins). Sem localização, não há declaração de localização no Play Console.
- [ ] Target API 36 (Expo SDK 58): atende ao requisito do Google.

**Envio**
- [ ] Primeiro AAB à mão (trilha interna); depois `eas submit` (trilha `internal`, rascunho).
- [ ] Teste fechado com 12 testadores por 14 dias (conta pessoal nova), antes de pedir produção.
- [ ] Acesso ao app para a revisão: as mesmas contas de demonstração do iOS e a nota do Conectar.
- [ ] Relatório de pré-lançamento sem falha; ícone, gráfico de destaque (1024 × 500), capturas de tela, descrição curta e completa.
- [ ] Push: `google-services.json` e a conta de serviço do FCM v1 no EAS; MAN-PUSH-01 passando no build da trilha interna.
