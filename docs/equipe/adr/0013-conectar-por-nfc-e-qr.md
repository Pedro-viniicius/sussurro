# ADR 0013: Conectar por NFC e QR code, sem Bluetooth

- Status: Aceita (PO, 2026-11-14) · Data: 2026-11-14
- Origem: pedido do PO em 2026-11-14: "fazer o mecanismo de NFC e conexão via QR code funcionar, não quero Bluetooth".
- **Substitui:** a ADR 0002 (módulo BLE) e a ADR 0012 (encostar por BLE, adendos A1 a A3) por inteiro, e a revisão do D3 de 2026-10-30.
- **Continua valendo:** a ADR 0003 (tokens efêmeros, pedido, aceite, corrida A→B ∥ B→A, recusa com intervalo, limites e falhas de token), o D7 (leitura cruzada no aceite) e a tela de criador bloqueada (4.8).

## Contexto

A Fase 4 implementou o "encostar" por BLE com observação mútua no servidor (ADR 0012). Nunca rodou em aparelho e dependia de calibração de RSSI por modelo, capa e orientação (R21, spike 4.1-B). O PO decidiu tirar o Bluetooth do produto e usar **NFC + QR code**.

**Fatos de plataforma** (já levantados na ADR 0012 e conferidos de novo):

- **Android** emula uma etiqueta NFC pelo Host Card Emulation (HCE, API 19+). Um app pode responder como uma *NFC Forum Type 4 Tag* (AID `D2760000850101`) e entregar uma mensagem NDEF. Também lê etiquetas pelo `NfcAdapter.enableReaderMode`.
- **iPhone** lê NDEF pelo Core NFC (`NFCNDEFReaderSession`, iPhone 7+), inclusive de um Android em HCE. **Não emite**: a emulação de cartão no iOS é restrita ao EEE, com entitlement e só para pagamento, transporte, acesso e ingressos.
- **Alcance do NFC:** cerca de 4 cm, ou seja, encostar de verdade. Ler à distância exige antena especial e ainda fica na faixa de dezenas de centímetros.

| Quem mostra | Quem lê | Caminho |
|---|---|---|
| Android | Android | NFC ou QR |
| Android | iPhone | NFC ou QR |
| iPhone | Android ou iPhone | QR (o iPhone não emite) |
| sem NFC | qualquer | QR |

## Decisão

### 1. Um código só, dois transportes

O NFC e o QR carregam **o mesmo conteúdo**: `sussurro://c/{token}`. No QR, como texto; no NFC, como registro NDEF URI. O consentimento é o mesmo nos dois casos: a pessoa abriu a tela Conectar e está mostrando o código. Não existe mais canal "do ar" (o anúncio BLE, legível a metros), então deixa de existir motivo para dois tokens.

- `POST /proximity/tokens` → `{token, expiresAt, renewInS}`, com 12 bytes de CSPRNG, 30 s válido, 120 s recente e rotação a cada 20 s, sem mudança.
- O registro no Valkey deixa de ter `ch`; o `resolve` aceita qualquer token válido de outra pessoa (como o `resolve` do QR já fazia).

### 2. Métodos: `qr` e `nfc`

- `ConnectionMethodSchema = 'qr' | 'nfc'`. O método só registra como o código foi lido (PROX-22); **as regras são as mesmas** para os dois.
- **Pedido** (`POST /connections/requests {targetToken, method}`): `targetToken` válido (até 30 s) de B, como o pedido `qr` de hoje.
- **Aceite** (`POST /connections/requests/:id/accept {observedToken}`): `observedToken` **obrigatório** nos dois métodos (D7). É o token de A lido por B na tela "Aguardando" de A (por QR ou NFC), dono = `from_id`, até 120 s. Sem ele → 400 `VALIDATION_ERROR`; de outra pessoa ou vencido → 400 `PROXIMITY_TOKEN_INVALID`, e o pedido continua pendente.
- **Banco:** migration aditiva `ALTER TYPE connection_method ADD VALUE 'nfc'`. O valor `ble` fica no tipo do Postgres só como histórico (tirar um valor de enum exige recriar o tipo, uma migration destrutiva que o PO não autorizou). Nenhuma escrita nova usa `ble`, e o seed passa a usar `qr`/`nfc`. Na leitura, o servidor mostra `ble` antigo como `nfc`, o encosto mais próximo.

### 3. O que sai do servidor

- `POST /proximity/touches`, `POST /dev/simulate-touch` e tudo o que só o encosto usava: observação (`prox:o`), par (`prox:m`), cartão devido (`prox:v`, `prox:c`), teto de pessoas novas (`rl:prox-pairs:*`), sinal de bloqueio depois do encosto e os env `PROX_TOUCH_*`.
- O pedido `ble` e o aceite sem `observedToken`.
- **Continuam:** `prox:u` (tela aberta), `prox:t`/`prox:r`, os limites de tokens (6/min), `resolve` (30/min), pedidos (10/min, 50/dia), aceites (10/min), falhas de token (20 em 10 min → 15 min bloqueado) e o fail-closed sem Valkey (503 `PROXIMITY_UNAVAILABLE`).

### 4. O módulo nativo `sussurro-proximity` vira NFC

O nome do módulo continua, mas o Bluetooth sai por completo: código, permissões e textos de Info.plist. API em TypeScript:

```ts
getNfcCapabilities(): Promise<{ supported: boolean; enabled: boolean; canEmit: boolean; canRead: boolean }>
setEmittedPayload(uri: string | null): void   // Android HCE; no-op no iOS (canEmit = false)
startReading(): Promise<void>                  // Android: reader mode contínuo; iOS: abre a folha do sistema
stopReading(): void
addListener('onNfcRead', (e: { uri: string }) => void)
addListener('onNfcReadError', (e: { code: 'cancelled' | 'timeout' | 'unsupported' | 'disabled' | 'read_failed' }) => void)
openNfcSettings(): void                        // Android; no-op no iOS
```

**Android (Kotlin):**
- Um `HostApduService` (`SussurroNdefService`) responde como Type 4 Tag: `SELECT` do AID `D2760000850101`, depois `SELECT` do CC (`E103`) e do arquivo NDEF (`E104`), e `READ BINARY` com offset e tamanho.
- Sem payload ativo, ele responde `6A82` (arquivo não encontrado), e o leitor não recebe nada.
- O payload fica **só em memória** (campo estático `@Volatile`). O app o grava ao abrir a tela Conectar e o apaga ao sair da tela, ao ir para o background e no `OnDestroy` do módulo.
- `apduservice.xml` com `android:requireDeviceUnlock="true"`, categoria `other` e o AID acima. O serviço é `exported` com `android:permission="android.permission.BIND_NFC_SERVICE"`, como o sistema exige.
- Leitura: `enableReaderMode` (NFC-A/B, `FLAG_READER_SKIP_NDEF_CHECK` desligado) na Activity atual. Usa `Ndef.get(tag)` e, se a tag não expuser Ndef, `IsoDep` com o mesmo diálogo de APDUs. Entrega o primeiro registro URI que começar com `sussurro://c/`, com no máximo um evento por token a cada 1,5 s.
- Enquanto o reader mode está ligado, o aparelho não é lido por outro. A tela separa "Mostrar" de "Ler" por isso.
- `uses-permission android.permission.NFC`, `uses-feature android.hardware.nfc` com `required=false` e `android.hardware.nfc.hce` com `required=false`.

**iOS (Swift):**
- `NFCNDEFReaderSession(invalidateAfterFirstRead: true)` com a mensagem de alerta "Aproxime o topo do iPhone das costas do outro celular." (texto aprovado pelo PO em 2026-11-14, `ux.md` §11.19, N26; corrigido nesta ADR em 2026-11-14). Entrega o mesmo evento.
- Entitlement `com.apple.developer.nfc.readersession.formats = [TAG]` (a Apple recusa `NDEF` desde o SDK do iOS 13, ITMS-90778; `TAG` cobre a leitura NDEF) e `NFCReaderUsageDescription`.
- `canEmit = false` sempre.

O config plugin (`app.plugin.js`) injeta o serviço, o XML, as permissões, o entitlement e o texto de uso. O BLE sai do plugin.

### 5. A tela Conectar

Dois modos, num seletor:

- **Mostrar meu código** (padrão):
  - QR grande com o @ e o avatar, renovado a cada 20 s sem piscar;
  - com `canEmit`, também emite por NFC, com o texto "Ou encoste o outro celular nas costas deste";
  - NFC desligado: "Ligar NFC".
- **Ler código:**
  - com NFC no Android: o reader mode fica ligado enquanto o modo está aberto, com a dica "Encoste nas costas do outro celular";
  - no iPhone: o botão "Aproximar do celular" abre a folha do sistema;
  - nos dois: o botão "Usar a câmera" (o `QrScanner` atual).
- Código lido (QR ou NFC) → `resolve` → cartão da pessoa → "Conectar" → pedido com `method` igual ao caminho da leitura → "Aguardando Caio confirmar". A tela "Aguardando" mostra o QR de quem pediu e emite por NFC, para o outro ler (D7).
- **Folha do pedido recebido:** "Aceitar" pede para ler o código de quem pediu, por NFC ou câmera. Lido um token do dono certo, o app aceita.
  - *Observação (2026-11-14):* com a câmera negada no aceite, o texto proposto é "Para aceitar, permita a câmera nos Ajustes e leia o código na tela de {primeiro nome}." (N28, `ux.md` §11.19), no lugar do `cameraDeniedText`, que manda a outra pessoa ler o seu código. **Aprovada pelo PO em 2026-11-14**; fora do aceite, o texto atual continua.
- O deep link `sussurro://c/{token}` (câmera do sistema ou uma tag NFC lida com o app fechado, que o Android entrega por intent `NDEF_DISCOVERED`) continua no fluxo do QR.

### 6. Riscos

| # | Risco | Mitigação |
|---|---|---|
| N1 | iPhone ↔ iPhone sem NFC | QR sempre disponível; a tela nunca depende do NFC |
| N2 | Outro app no Android responde ao mesmo AID NDEF | O leitor só aceita URI com o prefixo `sussurro://c/` e token bem formado; um código de outro app é ignorado |
| N3 | Captura do NFC à distância com antena especial | Mesma classe do QR fotografado de longe: token de 30 s, aceite exige leitura cruzada (D7), quem recebe vê o cartão e pode recusar; o HCE só responde com a tela aberta e o aparelho desbloqueado |
| N4 | Módulo nativo não compilado nesta máquina (sem Android SDK nem Mac) | Pendência: dev build EAS com o aval do PO; roteiros MAN-NFC-01 a 04 em aparelho |
| N5 | NFC desligado ou ausente | Estado próprio com "Ligar NFC" (Android) e o QR em destaque |

## Alternativas descartadas

- **Manter o BLE como reserva:** o PO não quer Bluetooth.
- **Dois tokens (NFC e QR):** sem um canal legível à distância, não há o que separar.
- **Aceite sem leitura cruzada no NFC:** mais rápido, mas o D7 continua decisão do PO; fica como pergunta para depois dos testes em aparelho.
- **`react-native-nfc-manager` + `react-native-hce`:** duas dependências nativas de terceiros, e o HCE não é coberto pelo primeiro. O módulo próprio já existe e precisa de cerca de 300 linhas.

## Consequências

- Some a calibração de RSSI (spike 4.1-B, R17, R21, R22, R23) e cerca de 10 mil linhas de código e testes do encosto.
- Os casos PROX de encosto (`touches`, A2, A3) saem do `testes.md`; entram (corrigido em 2026-11-14, conforme o `testes.md` §6.11):
  - NFC-01 a 09: testes de tela e de módulo do app (Jest, com o dublê `createFakeNfc`);
  - NFC-10 a 17: testes Kotlin do protocolo Type 4 (`SussurroNfcProtocolTest.kt`, JUnit na JVM), que **ainda não rodam no CI** nem nesta máquina e, até lá, não contam como cobertos;
  - NFC-MOD-*: bloquear e denunciar a contraparte de um pedido de conexão de até 24 h (Adendo B1, M1);
  - MAN-NFC-01 a 04: roteiros em aparelho.
- A Política de Privacidade troca "Bluetooth" por "NFC (só com a tela Conectar aberta)".

## Adendo B1 (2026-11-14): revisão do `seguranca`

Sem achado CRÍTICO nem ALTO. Decisões do Tech Lead sobre os demais:

- **M1, bloquear e denunciar um desconhecido do Conectar.**
  - A exceção do par encostado (ADR 0012, R1-5) saiu junto com o BLE. Sem ela, quem recebia um pedido de alguém que fotografou o QR ou capturou o NFC só conseguia recusar.
  - **Decisão:** `canBlockOrReport` passa a valer também para a **contraparte de um pedido de conexão entre os dois criado nas últimas 24 h** (`CONNECTION_REQUEST_MODERATION_WINDOW_S`), em qualquer direção e qualquer status.
  - A regra fica no Postgres, sem Valkey. Quando não pode, a resposta é a mesma de hoje, então não vira oráculo.
  - No app, os botões ficam na folha do pedido recebido, não no cartão do código lido antes de existir pedido.
- **M2, emissão em background.**
  - O nativo só aceita um payload com a Activity em primeiro plano.
  - O payload guarda um prazo de 30 s; vencido, o serviço responde `6A82`.
- **Baixos.**
  - A leitura IsoDep tem limite de APDUs e de tempo.
  - O nativo só entrega ao JS uma URI com o tamanho exato e um token base64url.
  - O plugin remove as permissões de Bluetooth e de localização também do manifesto mergeado (`tools:node="remove"`).
  - O deep link e o `NDEF_DISCOVERED` nunca enviam um pedido sem o toque da pessoa.
- **Registrado sem mudança:** tempo de resposta diferente entre @ inexistente e @ não visível (já existia, mesma classe do `GET` de perfil).

**Segunda revisão do `seguranca`, sobre o app:** sem CRÍTICO, ALTO nem MÉDIO. Os 4 BAIXOS foram corrigidos:
- trava única entre a gravação e o background no `SussurroNfcPayload`;
- o serviço confere o primeiro plano a cada leitura;
- `ACCESS_COARSE_LOCATION` e `ACCESS_BACKGROUND_LOCATION` também saem com `tools:node="remove"`;
- o NFC para de emitir com a câmera ou o formulário de denúncia por cima do QR (NFC-09, com mutação verificada).
