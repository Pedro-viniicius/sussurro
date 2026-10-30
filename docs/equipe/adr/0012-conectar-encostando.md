# ADR 0012: Conectar encostando os celulares, com observação mútua no servidor e QR de reserva

- Status: Aceita (PO, 2026-10-30) · Data: 2026-10-30
- Origem: revisão do D3 e substituição do D13 pelo PO em 2026-10-30 (`PROJETO.md` §8.2).
- Substitui em parte:
  - **ADR 0002:** a potência e o campo TX Power do anúncio, o evento da varredura e as capacidades;
  - **ADR 0003:** o `resolve` por Bluetooth, o token único para BLE e QR e o token cruzado no aceite do método `ble`;
  - as faixas "bem perto / por perto" (`arquitetura.md` §11.2).
- O resto das duas ADRs continua valendo.

## Contexto

**Como funciona hoje** (Fase 4 implementada, nunca testada em aparelho):
- com a tela Conectar aberta, o app anuncia o token por BLE e varre;
- cada token visto vai para o `POST /proximity/resolve`, que devolve @, nome e foto de **qualquer** token válido;
- a lista "Por perto agora" mostra quem está acima de -90 dBm, o que dá vários metros;
- a resposta do `POST /connections/requests` também traz `other {handle, name, avatarUrl}`.

**A decisão do PO:** só quem encosta o celular vê a pessoa. Quem está a alguns metros não deve nem enxergá-la.

**Fatos de plataforma** (verificados em 2026-10-30; fontes no fim):

- **NFC:**
  - o Core NFC só lê etiquetas;
  - a emulação de cartão (HCE) no iPhone só existe para apps do Espaço Econômico Europeu, com entitlement e para pagamentos, ingressos, transporte e acessos [1];
  - resultado: iPhone ↔ iPhone não funciona.
- **iOS anunciando:**
  - o `CBPeripheralManager` só aceita `LocalName` e `ServiceUUIDs` [2]; a potência e o intervalo não são configuráveis;
  - a chave de TX Power é recusada no anúncio [3];
  - consequência: o iPhone anuncia na potência do sistema e é ouvido a vários metros.
- **Android anunciando:**
  - `AdvertiseSettings.setTxPowerLevel` tem `ULTRA_LOW`, `LOW`, `MEDIUM` (o que usamos hoje) e `HIGH`; no AOSP correspondem a -21, -15, -7 e +1 dBm [4]. O valor é nominal e depende do chip;
  - `AdvertiseData.setIncludeTxPowerLevel(true)` põe o campo TX Power (3 bytes) no anúncio. O pacote fica com 24 de 31 bytes (flags 3 + UUID de 128 bits 18 + TX 3);
  - o receptor lê o campo em `ScanRecord.getTxPowerLevel()` no Android (`Integer.MIN_VALUE` sem o campo) e em `CBAdvertisementDataTxPowerLevelKey` no iOS, e estima a perda como TX − RSSI [5][6].
- **Variação de RSSI:**
  - o padrão de calibração "Presence" do Android aceita mediana de RSSI a 1 m entre -65 e -45 dBm (20 dB de janela entre aparelhos) e até 18 dB de amplitude em 1.000 leituras do mesmo aparelho [7];
  - orientação, corpo e modelo mudam o RSSI tanto quanto andar 2 m [8];
  - o iOS manda RSSI 127 quando não mediu [9].
- **Android varrendo:**
  - a partir do Android 7, mais de cerca de 5 inícios de varredura em 30 s fazem o sistema segurar a varredura em silêncio [10];
  - no Android ≤ 11, varrer exige `ACCESS_FINE_LOCATION` [11] **e** a localização do sistema ligada; desligada, a varredura volta vazia, sem erro [12];
  - no Android 12+, `neverForLocation` dispensa a localização, mas filtra alguns beacons [11]. O nosso anúncio não é beacon.
- **Piso do Expo:** suporta Android 7+ [13], então Android 7 a 11 entram no público.

**Consequência central:** a força do sinal é medida pelo cliente, e qualquer um lê o anúncio.
- Um scanner passivo a 10 m lê o UUID de um iPhone, e um cliente modificado mente o RSSI.
- Se o servidor continuar resolvendo qualquer token válido, a regra do PO vira só uma regra de interface, e o pedido de conexão continua revelando a pessoa.
- **A garantia precisa estar no servidor.**

## Decisão

### 1. Dois tokens por emissão, um por canal

`POST /proximity/tokens` passa a devolver `{bleToken, qrToken, expiresAt, renewInS}`:
- os dois têm 12 bytes de CSPRNG, a mesma validade (30 s válido, 120 s recente) e a mesma rotação (20 s);
- os dois são gravados como hash, com o canal no registro: `{uid, iat, ch: 'ble' | 'qr'}`;
- o `bleToken` só vai no anúncio e nunca é resolvido sozinho;
- o `qrToken` só aparece na tela, no QR, e nunca vai ao ar.

**Por quê:** se o anúncio e o QR usassem o mesmo token, quem lesse o anúncio a 10 m usaria o caminho do QR (`resolve`) para descobrir a pessoa.

O limite de 6 emissões por minuto não muda: cada emissão já traz os dois tokens. A marca de "tela aberta" (`prox:u`) também não muda.

### 2. Detecção do "encostado" no cliente (o que o app afirma)

A detecção roda no app, em TypeScript puro e testável (`touch-detector.ts`). Os valores ficam num **ponto único de calibração**, `apps/mobile/src/features/connect/touch-calibration.ts`:
- o nativo recebe a potência e o intervalo mínimo entre eventos como parâmetros;
- Swift e Kotlin não guardam nenhum limiar.

**Métrica: perda estimada, em dB.**
- `perda = txRef − rssi − correçãoRx`; quanto menor, mais perto.
- `txRef`:
  - anúncio **com** o campo TX Power (Android): o valor do campo. Se o spike mostrar campo errado em algum chip, usa `androidAdvertiserTxDbm`;
  - anúncio **sem** o campo (iPhone): `iosAdvertiserTxDbm`.
- Assim a potência do Android vira um botão de calibração, sem refazer os limiares.
- `correçãoRx` é a correção de quem recebe, por plataforma, mais uma tabela opcional por modelo (só para os outliers medidos). O nativo informa o modelo, que é usado só no aparelho.

**Suavização e tempo sustentado, por token:**
1. Mediana das amostras dos últimos `windowMs`, exigindo pelo menos `minSamples`. A mediana ignora os vales de desvanecimento por multipercurso, que a média puxaria.
2. Estados de cada token:

| Estado | Condição |
|---|---|
| `longe` | mediana > `nearMaxLossDb` |
| `quase` | mediana ≤ `nearMaxLossDb` (o app pode mostrar "aproxime mais") |
| `encostando` | mediana ≤ `enterMaxLossDb` |
| `encostado` | `encostando` sustentado por `holdMs` |

3. Histerese: sai de `encostado`/`encostando` só com mediana > `exitMinLossDb`.
4. RSSI 127, positivo ou abaixo de -127 é descartado.
5. Token novo (rotação de 20 s) começa do zero. O custo é cerca de 0,7 s a mais se a rotação cair no meio do encosto.

**Relato ao servidor:**
- quando um token entra em `encostado`, o app manda `POST /proximity/touches`;
- repete a cada `reportEveryMs` por até `reportForMs` (8 s), contados do primeiro `encostado`, **mesmo que os celulares já tenham se afastado**, e para quando o servidor devolve o cartão;
- **por quê:** cada aparelho detecta num tempo; se quem detectou primeiro parasse de relatar ao afastar, o segundo receberia o cartão e o primeiro não, e a revelação deixaria de ser simétrica;
- sem cartão aberto, cada chamada leva **um** token: o de menor perda. Com cartão aberto, o app não relata nada. Assim só existe um par por vez, e quem encosta ao mesmo tempo não recebe o cartão de quem não o recebeu (P8 do UX);
- as chamadas não se sobrepõem;
- o RSSI, o campo TX e o modelo **nunca saem do aparelho**.

**Constantes iniciais.** São provisórias: só dão um ponto de partida ao código, e o spike 4.1-B substitui os valores.

| Constante | Inicial | Para que serve |
|---|---|---|
| `android.advertiseTxPower` | `ultraLow` | potência do anúncio no Android (`ultraLow`, `low`, `medium` ou `high`) |
| `android.includeTxPowerField` | `true` | põe o campo TX Power no anúncio |
| `trustAdvertisedTx` | `true` | `false`: ignora o valor do campo e usa `androidAdvertiserTxDbm` |
| `androidAdvertiserTxDbm` | -21 | TX assumido do Android quando o campo não é confiável |
| `iosAdvertiserTxDbm` | 0 | TX assumido do iPhone (anúncio sem o campo) |
| `rxCorrectionDb` | `{ios: 0, android: 0}` | correção de quem recebe, por plataforma |
| `modelCorrectionDb` | `{}` | correção por modelo de quem recebe (só os medidos) |
| `sightingMinIntervalMs` | 200 | no máximo 1 evento por UUID a cada 200 ms (hoje 500 ms, fixo no nativo) |
| `windowMs` / `minSamples` | 1500 / 3 | janela da mediana |
| `enterMaxLossDb` | 40 | entra em `encostando` |
| `exitMinLossDb` | 46 | sai (histerese de 6 dB) |
| `nearMaxLossDb` | 52 | faixa `quase` |
| `holdMs` | 700 | tempo sustentado até `encostado` |
| `reportEveryMs` / `reportForMs` | 1000 / 8000 | relato ao servidor |
| `confirmWarnAfterMs` | 4000 | a tela avisa "Não deu para confirmar" (o relato continua até `reportForMs`) |
| `noTouchFallbackMs` | 20000 | 20 s no Pronto sem `encostado`: QR em destaque |
| `nearFallbackMs` | 10000 | 10 s em `quase` sem confirmar: QR em destaque |
| `failuresBeforeQr` | 2 | dois "Não deu para confirmar" seguidos: QR em destaque |
| `cardTtlMarginMs` | 5000 | o app tira o cartão 5 s antes do fim do par (55 s), para o pedido não chegar com o par vencido |

Com isso, a detecção leva cerca de 1 a 1,5 s depois do contato, e o "casamento" no servidor mais 1 a 2 s.

**Diferenças entre iOS e Android:**

| | iOS | Android |
|---|---|---|
| **Anúncio** | potência do sistema, sem o campo TX; receptores tratam "sem campo" como iPhone | potência configurável (`ULTRA_LOW` como padrão inicial), com o campo TX, `LOW_LATENCY`, não conectável |
| **Varredura** | primeiro plano, `AllowDuplicates`, filtro do prefixo em código | `SCAN_MODE_LOW_LATENCY` (só com a tela aberta), `ScanFilter` com máscara |

**Varredura no Android:**
- **uma sessão contínua por tela**: o app não para e reinicia a varredura ao mudar de estado (limite de cerca de 5 inícios em 30 s);
- reinicia só quando o Bluetooth liga ou desliga, ou ao voltar do background.

**Android ≤ 11:** `getCapabilities` passa a informar `locationServices: 'on' | 'off' | 'not_required'`. Com a localização desligada, a tela mostra um estado próprio e o QR.

**Capas e modelos:** não há como prever todas as combinações. As mitigações:
- margem entre os limiares de entrar e sair;
- correção por plataforma, e por modelo só para os outliers medidos;
- a dica "aproxime mais" na faixa `quase`;
- o QR em destaque pelos tempos `noTouchFallbackMs`, `nearFallbackMs` e `failuresBeforeQr`.

O spike mede três capas: sem capa, silicone fina e carteira grossa ou com ímã.

### 3. Observação mútua no servidor (o que o servidor garante)

Um token BLE só vira pessoa quando **os dois aparelhos afirmaram, numa janela curta, que viram o token um do outro já no limiar de encostado**. A afirmação de um cliente sozinho não revela nada: o aparelho honesto da outra pessoa só afirma ter visto o atacante se o sinal dele chegou com força de encosto, o que a 10 m não acontece com um celular comum.

**`POST /proximity/touches {tokens: [1..4]}`.** Exige conta pessoal, e-mail confirmado, tela aberta (409 `PROXIMITY_SCREEN_CLOSED`) e não estar bloqueado; limite de 60 por minuto (o app relata 1 por segundo por até 8 s em cada encosto). O que o servidor faz:

1. Para cada token distinto, aceita só o que estiver **válido** (até 30 s) no `prox:t`, com `ch = 'ble'` e dono diferente de quem chama. Os outros são ignorados em silêncio e não contam como falha.
2. Para cada dono O, num script Lua (atômico):
   - `SET prox:o:{caller}:{O} <agora> PX janela`;
   - `EXISTS prox:o:{O}:{caller}`: se existe, é **mútuo**.
3. Para os mútuos, a política (como no `resolve` de hoje: `ProximityRepository.findNearby` com `hideBlockedFor`) exige conta pessoal, ativa e sem bloqueio em nenhum sentido. Para os que passam:
   - `SET prox:m:{menorUid}:{maiorUid} <agora> PX parTtl`;
   - a pessoa entra na resposta como `NearbyPerson` (o token informado, @, nome, foto e `alreadyConnected`).
4. A resposta é sempre 200 `{items}`. Token não mútuo, vencido, inexistente, do próprio chamador, de criador, de conta excluída ou com bloqueio é indistinguível: simplesmente não aparece.

**Revelação simétrica.** Quem relata primeiro recebe `items: []` e, no relato seguinte (cerca de 1 s depois), o cartão. Ninguém vê quem não o vê.

**Tempos** (env da API, com padrão no `packages/shared`):

| Variável | Padrão | O que é |
|---|---|---|
| `PROX_TOUCH_WINDOW_S` | 10 | janela entre os dois relatos |
| `PROX_TOUCH_PAIR_TTL_S` | 60 | quanto tempo o par encostado vale para pedir |

- A validação do env exige `PROX_TOUCH_PAIR_TTL_S + PROX_TOKEN_TTL_S ≤ PROX_RECENT_TTL_S` (60 + 30 ≤ 120). Assim, o token devolvido no casamento ainda é "recente" durante todo o par.
- A validação também exige `PROX_TOUCH_WINDOW_S ≤ PROX_TOKEN_TTL_S`.

**O `resolve` passa a servir só ao QR.** Token com `ch = 'ble'` não resolve; a resposta é igual à de token inexistente.

**O que o servidor revela antes do aceite, e para quem:**

| Situação | Quem chama | O que recebe |
|---|---|---|
| Token BLE lido do ar (scanner passivo, cliente modificado), sem encosto mútuo | qualquer conta pessoal | nada: `touches` → `items: []`; `resolve` → `items: []`; pedido → 400 `PROXIMITY_TOKEN_INVALID` (genérico, conta como falha) |
| Encosto mútuo | A e B | o cartão um do outro (@, nome, foto, `alreadyConnected`) |
| QR lido | quem leu | o cartão de quem mostrou o QR (consentimento de mostrar o código) |
| Pedido recebido | B | o cartão de A na folha (igual a hoje) |
| Bloqueio, conta excluída, criador | — | o mesmo que inexistente |

### 4. Pedido e aceite

**Pedido `ble`** (`{targetToken: tB, method: 'ble'}`):
- `tB` precisa estar **válido ou recente** (até 120 s), com `ch = 'ble'` e dono B;
- `prox:m` do par A–B precisa existir;
- sem o par, com canal trocado ou com o token de outra pessoa → 400 `PROXIMITY_TOKEN_INVALID`, contado como falha;
- daí em diante, tudo igual à Fase 4a: trava do par, política, intervalo depois da recusa, corrida A→B ∥ B→A e pendente único;
- o token pode estar só "recente" porque o app conhece apenas o token devolvido no casamento: depois da rotação, ele não consegue mais ligar os tokens novos de B a B. A prova forte é o par.

**Pedido `qr`:** igual a hoje, mas `targetToken` precisa ter `ch = 'qr'`.

**Aceite `ble`:**
- dispensa o `observedToken`: se vier, é ignorado;
- continua exigindo tela aberta, pedido pendente e não vencido, para B;
- **motivo:** o pedido só nasce com o par mútuo, e o par já prova que B viu o token de A com força de encosto. Isso é mais forte que o token cruzado da ADR 0003, e some o problema da A-10 (o `tA` envelhecendo com a folha aberta);
- a folha de um pedido `ble` deixa de ligar a varredura.

**Aceite `qr`:**
- `observedToken` obrigatório (sem ele → 400 `VALIDATION_ERROR`), com `ch = 'qr'`, dono igual a `from_id` e até 120 s;
- token de canal trocado → 400 `PROXIMITY_TOKEN_INVALID`, e o pedido continua pendente.

**Fluxo de produto.** O protocolo serve a dois fluxos ao mesmo tempo:
- (a) cartão → "Conectar" → folha e aceite do outro;
- (b) os dois tocam "Conectar" e a corrida vira conexão na hora.

A tela é do UX/UI. O PO decidiu (a) + (b) (decisão 1, abaixo).

### 5. QR de reserva

O D7 continua igual: B lê o QR de A para aceitar, e o QR leva o `qrToken` (`sussurro://c/{qrToken}`). `parseProximityQr` e o deep link não mudam.

O app oferece o QR, pelo seletor, sempre, e como saída principal quando:
- falta permissão de Bluetooth e não dá para pedir de novo;
- o Bluetooth está desligado (junto com "Ligar");
- o aparelho não tem BLE ou o módulo não existe no build (Expo Go, dev build antigo);
- o aparelho **não anuncia** (`canAdvertise = false`). O "Procurar mesmo assim" sai: só varrer não serve, porque o encosto exige os dois anunciando;
- é Android ≤ 11 com a localização do sistema desligada;
- passaram 20 s no Pronto sem `encostado`, 10 s em `quase` sem confirmar ou dois "Não deu para confirmar" seguidos (P9 do UX), inclusive quando um lado vê "encostado" e o outro não.

### 6. Limites de tentativas

| Limite (por conta) | Antes | Depois |
|---|---|---|
| Tokens | 6/min | 6/min (cada emissão traz os dois) |
| `resolve` | 30/min | 30/min, só QR |
| `touches` | — | 60/min, até 4 tokens por chamada (o app manda 1); nunca conta como falha |
| Pedidos | 10/min e 50/dia | igual |
| Aceites | 10/min | igual |
| Falhas de token | 20 em 10 min → proximidade bloqueada por 15 min | igual; passam a contar também o pedido `ble` sem par e o token de canal trocado |

Os novos limites ficam no `ProximityStore`, falham fechados e rodam sem Valkey em 503 `PROXIMITY_UNAVAILABLE`, como os outros.

### 7. Contratos (sem migration)

**`packages/shared` vem primeiro:**
- `proximity.ts`:
  - `ProximityTokenSchema` → `{bleToken, qrToken, expiresAt, renewInS}`;
  - novos `ProximityTouchRequestSchema` (`strictObject {tokens: 1..4}`) e `ProximityTouchResultSchema` (`{items: NearbyPerson[]}`);
  - novas constantes `PROXIMITY_TOUCH_MAX_TOKENS` (4), `PROXIMITY_TOUCH_WINDOW_S` (10), `PROXIMITY_TOUCH_PAIR_TTL_S` (60) e `PROXIMITY_TOUCH_REPORT_INTERVAL_S` (1);
  - os helpers de UUID e QR não mudam.
- `connections.ts`:
  - `AcceptConnectionRequestSchema` → `{observedToken?}` (obrigatório no `qr` pela regra do serviço);
  - `ConnectionMethodSchema` continua `ble | qr`: `ble` passa a significar "encostando".

**Rotas da API:**
- nova: `POST /v1/proximity/touches`;
- mudam: `POST /proximity/tokens` (resposta), `POST /proximity/resolve` (só `qr`), `POST /connections/requests` (canal e par) e `POST /connections/requests/:id/accept` (por método);
- `POST /dev/simulate-request` continua: no `ble`, grava o par da persona; o `observedToken` devolvido passa a ser o `qrToken` da persona;
- opcional: `POST /dev/simulate-touch` (só em desenvolvimento) grava a observação de uma persona e devolve o `bleToken` dela, para testar o casamento com um aparelho só;
- toda rota nova entra no canário PERM-10.

**Chaves no Valkey:**
- `prox:t` e `prox:r` ganham `ch`;
- novas: `prox:o:{observador}:{dono}` (10 s), `prox:m:{a}:{b}` (60 s) e `rl:prox-touches:user`;
- `prox:u`, `prox:ut` e `prox:lock` não mudam;
- o logout não precisa apagar `prox:o`/`prox:m`: vencem em até 60 s, e o pedido exige tela aberta e token válido de quem chama.

**Códigos de erro:** nenhum novo. O par vencido devolve o `PROXIMITY_TOKEN_INVALID` genérico; o app sabe a hora do casamento e, antes disso, já troca o "Conectar" por "Encostem de novo".

**Banco:** **sem migration**. `connection_method` continua `ble | qr`, e não há SQL novo (o `findNearby` é reaproveitado).

### 8. Calibração em aparelhos reais (spike 4.1-B, substitui a meta do MAN-BLE-01)

**Pré-requisitos:**
- dev build do EAS, Android e iOS (precisa do aval do PO);
- uma tela `/dev/proximidade`, só na variante `development`, como o D15:
  - mostra ao vivo, por token: RSSI, campo TX, perda, mediana e estado;
  - escreve linhas CSV no `console`, capturadas no terminal do Metro;
  - sem dependência nova e sem enviar nada ao servidor;
- aparelhos I1, I2, A1 e A2 (A3 opcional) e três capas (sem capa, silicone fina, carteira grossa ou com ímã).

**Roteiro, em cada par e nos dois sentidos** (I1↔I2, I1↔A1, I2↔A2, A1↔A2):
1. Posições:
   - os quatro gestos da §9 (topo com topo, lado a lado, base com base, costas com costas);
   - as distâncias 5 cm, 15 cm, 30 cm, 50 cm, 1 m, 3 m e 10 m (corredor, com e sem uma pessoa no meio);
   - 30 s por posição, na mão e sobre a mesa.
2. Android com `ULTRA_LOW` e com `LOW` (duas rodadas).
3. Registrar por posição: mediana, P10 e P90 da perda; tempo até `encostado`; quantos estados `encostado` fora do contato.
4. 20 encostos naturais por par, com pessoas seguindo só o texto da tela.
5. Conferir:
   - se o campo TX lido no outro aparelho bate com o nível pedido (`trustAdvertisedTx`);
   - o Android ≤ 11 com a localização desligada;
   - o PROX-28 no nRF Connect (sem nome, potência baixa e campo TX no Android);
   - que um scanner a 10 m não recebe nenhum cartão.

**Critério de aprovação, por par e por capa:**
- encosto detectado e casado em até 3 s em pelo menos 95% das 20 tentativas;
- **nenhum** `encostado` a 30 cm ou mais em 5 min parado (requisito do UX, P2);
- `quase` em no máximo 5% das leituras a 1 m ou mais (o `quase` não revela ninguém: falso `quase` é só uma dica errada);
- mediana do tempo até casar ≤ 2 s.

**Saída:**
- os valores em `touch-calibration.ts`, com data, aparelhos e versão;
- o relatório e os prints em `docs/evidencias/fase-4/`;
- correções por modelo só para os outliers;
- o gesto escolhido (§9);
- par que não cumprir usa o QR (decisão 3 do PO).

### 9. Gesto, orientação e NameDrop (risco levantado pelo UX/UI)

**O risco:**
- entre dois iPhones desbloqueados, aproximar os aparelhos abre o **NameDrop** (troca de contatos do sistema) por cima do app;
- a Apple descreve o gesto como segurar um iPhone a poucos centímetros do outro [14];
- há relato de que dispara também com os celulares lado a lado, e a Apple confirma que **não existe API para pausar o NameDrop** dentro de um app [15];
- o NameDrop não compartilha nada sozinho: a pessoa escolhe "Compartilhar" ou "Só receber", e afastar ou bloquear o aparelho cancela [16]. Só a própria pessoa desliga, em Ajustes > Geral > AirDrop > "Aproximar dispositivos" [16];
- **não acontece** entre iPhone e Android.

**O conflito:** o gesto que menos provoca o NameDrop pode afastar as antenas. Base com base, por exemplo, deixa as partes de cima a uns 30 cm uma da outra, e não se sabe onde fica a antena de Bluetooth de cada modelo. Por isso o gesto não se decide no papel: decide-se no spike.

**Recomendação de arquitetura:**
- **Distância:** encostados, até cerca de 2 cm. O limiar de entrada (`enterMaxLossDb`) é calibrado para o contato, não para "perto".
- **Orientação:** a do gesto vencedor no spike. Enquanto isso, o "topo com topo" do UX fica como provisório (D-UX23).
- **Duração:**
  - "segurem um instante" até o **cartão** (casamento no servidor), não até o `encostado` local;
  - a vibração e o "pode afastar" pertencem ao estado Encostado (cartão), como já está na `ux.md` §11.4;
  - quem afastar depois do `encostado` local, mas antes de o outro detectar, impede o casamento.
- **Regra de escolha:**
  1. entre os gestos que cumprem o critério de detecção da §8, o que tiver **menor incidência de NameDrop** entre iPhones;
  2. se todos dispararem o NameDrop, o mais natural, com a nota T41 só no iPhone (`ux.md`);
  3. o app nunca pede para desligar o recurso do sistema.
- **Detectar o NameDrop:** não há sinal confiável. Se o UX quiser a nota só quando o NameDrop provavelmente abriu, existe uma heurística: no iPhone, o app passar a `inactive` durante o Confirmando ou o Encostado. Mas a central de controle e outros alertas também fazem isso, então é decisão do UX.

**O que testar em aparelho** (entra no spike 4.1-B):
1. **Configuração:** I1↔I2, os dois desbloqueados, com o Sussurro no Encostar e "Aproximar dispositivos" ligado (o padrão).
2. **Tentativas:** 20 por gesto (topo com topo, lado a lado, base com base, costas com costas).
3. **Medir em cada tentativa:**
   - se o NameDrop apareceu, e em quanto tempo;
   - em quanto tempo saiu o cartão do Sussurro;
   - se o casamento aconteceu mesmo com o NameDrop na tela, ou seja, se a varredura e o anúncio continuaram;
   - o estado do app durante o NameDrop (`inactive` ou `background`; em `background`, tudo para e recomeça na volta);
   - se, ao fechar o NameDrop, a tela volta no mesmo estado.
4. **Controle:** os mesmos gestos com "Aproximar dispositivos" desligado, e em I1↔A1 (não pode aparecer NameDrop).
5. **Detecção:** a perda de cada gesto em todos os pares da matriz (§8).

### 10. Premissas do UX/UI (`ux.md` §11.2): confirmação

| # | Premissa do UX | Resposta da arquitetura |
|---|---|---|
| P1 | Nome, @ e foto só depois de o servidor confirmar a observação mútua | **Confirmada** (§3). A revelação é simétrica, mas não simultânea: quem relata primeiro recebe o cartão no relato seguinte, cerca de 1 s depois. |
| P2 | Dois limiares no cliente, "aproximando" e "encostado"; o "encostado" nunca a 30 cm, o "aproximando" nunca a mais de 1 m | **Confirmada, com ressalva.** São o `quase` (`nearMaxLossDb`) e o `encostado` (`enterMaxLossDb` + `holdMs`, cerca de 1 s). Os 30 cm viraram critério do spike (§8), e o 1 m do `quase` virou meta (no máximo 5% das leituras). "Nunca" vale para os pares medidos; num aparelho fora da matriz é meta, não garantia, porque a variação entre modelos chega a 20 dB [7]. O que vale sempre: ninguém é revelado sem os dois lados afirmarem o encosto. O "aproximando" também diz à pessoa que há alguém com a tela Conectar aberta a cerca de 1 m (não quem), o que é coerente com o prefixo do anúncio (R17). Na tela, nada muda. |
| P3 | O servidor confirma o outro lado em até 4 s | **Corrigida.** O normal é 1 a 3 s, e os 4 s ficam como o tempo do aviso (`confirmWarnAfterMs`). Mas o app **continua relatando até 8 s** depois do primeiro `encostado`, mesmo afastado. Sem isso, quem detectou primeiro poderia nunca receber o cartão, enquanto o outro recebe. **Muda na tela:** depois do "Não deu para confirmar" (estado 9), um casamento que chegar até 8 s depois do encosto ainda abre o cartão (transição 9 → 11). |
| P4 | O cartão vale 60 s depois de encostar, mesmo afastados | **Confirmada, com dois ajustes.** Os 60 s contam do casamento no servidor, e o app usa 55 s (`cardTtlMarginMs`). E os 60 s são o prazo para **pedir**: o aceite segue a validade do pedido (120 s a partir do pedido), sem depender do par. Na tela, o estado 17 (o cartão venceu) acontece aos 55 s. |
| P5 | Se os dois tocam em "Conectar", a conexão sai na hora | **Confirmada:** é a corrida A→B ∥ B→A, já tratada. Precisa que o segundo toque aconteça dentro dos 60 s do par; depois disso, o cartão já virou "Aceitar" pelo polling, e o aceite não depende do par. |
| P6 | Quem não anuncia vai para o QR; o "Procurar mesmo assim" deixa de existir | **Confirmada** (§5). |
| P7 | A busca começa ao abrir a aba | **Confirmada**, com três condições. (1) Só com a permissão já dada; nada de pedido do sistema sem a explicação. (2) No Android, uma sessão de varredura por visita à aba, com uns 500 ms de espera antes de começar: abrir e fechar a aba várias vezes seguidas esbarraria no limite de cerca de 5 inícios em 30 s [10]. (3) Para ao sair da aba e no background, como hoje. A decisão da 4b de anunciar só depois do toque deixa de valer: o anúncio sozinho não identifica ninguém. |
| P8 | Uma pessoa por vez | **Confirmada**, e garantida pelo protocolo: sem cartão, o app relata só o token de menor perda; com cartão, não relata nada (§2). Quem encosta ao mesmo tempo não recebe o cartão de quem não o recebeu. |
| P9 | QR em destaque depois de 20 s no Pronto, 10 s no "aproximando" ou 2 falhas seguidas | **Confirmada.** Os tempos ficam no arquivo de calibração (`noTouchFallbackMs`, `nearFallbackMs`, `failuresBeforeQr`). |
| P10 | Bloqueio e falha não se distinguem para quem encostou | **Confirmada** (§3): `touches` devolve o mesmo `items: []` para bloqueio, conta excluída, criador, token vencido e falta de encosto mútuo. Quem não confirmou o e-mail nem recebe token. O pedido devolve o mesmo 400 genérico. Só a falta de rede se distingue (estado 18). |
| P11 | O método gravado na conexão continua `ble` | **Confirmada:** `ble` = encostando, sem valor novo e sem migration. |

## Alternativas

1. **NFC.** Descartado: no iPhone, o Core NFC só lê etiquetas, e a emulação de cartão exige o Espaço Econômico Europeu e um entitlement para pagamentos e acessos [1]. iPhone ↔ iPhone não funcionaria.
2. **Só QR.**
   - Prós: o mais privado (nada vai ao ar), funciona em qualquer aparelho e já está pronto.
   - Contras: mais atrito (câmera, permissão, luz, segunda leitura no D7) e não atende ao "encostar" que o PO pediu.
   - Fica como reserva.
3. **Bluetooth no alcance atual** (lista "Por perto"). Descartado: é justamente o que o PO quer evitar (quem está a metros vê nome, @ e foto).
4. **Encostar com limiar só no cliente** (o `resolve` aceitaria um "encostado: sim" do app). Descartado: um scanner passivo ou um cliente modificado ignora o limiar. Enviar o RSSI ao servidor também não resolve, porque o número vem do mesmo cliente, e ainda expõe o sinal.
5. **Encostar + QR, com observação mútua: escolhida.** Outras garantias de servidor avaliadas:

| Opção | Impede o scanner a 10 m? | Custo | Decisão |
|---|---|---|---|
| Observação mútua | **sim**: exige que o aparelho honesto da vítima afirme ter visto o atacante com força de encosto | 1 rota, 2 chaves, 1 script Lua | **escolhida** |
| Revelação cega (nenhum cartão antes do aceite; o par só vê quem é depois que os dois confirmam) | sim | aceite sem ver quem é; mais fraca contra relay; UX pior | descartada |
| "Bump" por acelerômetro + horário (como o antigo app Bump) | parcialmente | ambíguo em multidão; para desempatar precisaria de localização (custo de privacidade) | descartada |
| UWB / Nearby Interaction (distância medida) | sim | fora da v1 (`PROJETO.md` §5); poucos Androids com UWB | futuro |

## Consequências

- **Privacidade bem mais forte:**
  - a 10 m não se descobre ninguém pelo Bluetooth, nem com cliente modificado;
  - o servidor fica sabendo de menos pares: só quem encostou, em vez de todos que estavam "por perto";
  - o registro do encosto vive até 60 s no Valkey e não vai para o Postgres nem para os logs.
- **Riscos que ficam** (registrados na `arquitetura.md` §16):
  - **relay ativo:** dois aparelhos encostados nos dois alvos retransmitindo os anúncios (R12);
  - quem consegue pôr o celular a poucos centímetros do da vítima enquanto ela está com a tela Conectar aberta;
  - **o prefixo fixo** `53555353` ("SUSS") revela que alguém por perto está com a tela Conectar aberta, mas não quem.
- **Falso negativo é o novo risco de produto:**
  - os limiares dependem de aparelho, capa e orientação [7][8];
  - mitigações: mediana + hold, histerese, dica "aproxime mais", correções por plataforma e modelo, QR depois de 20 s, e o spike como portão;
  - a Fase 4 não fecha sem o spike 4.1-B aprovado.
- **Calibração exige build novo:** o app não tem `expo-updates`, então os valores de `touch-calibration.ts` só mudam com build novo. O PO decidiu não adicionar atualização OTA por agora (decisão 6); o tema volta se o campo mostrar necessidade.
- **O app fica mais simples:**
  - saem a lista "Por perto", as faixas, o `resolve` em lote (A-17), a varredura da folha (A-10 e PROX-26 no `ble`) e o "Procurar mesmo assim";
  - entram o detector de encosto, a chamada `touches` e o estado de localização do Android ≤ 11.
- **Política de Privacidade e textos de permissão mudam** (`arquitetura.md` §15):
  - quem vê o quê;
  - o registro do encosto;
  - a potência baixa no Android;
  - o prefixo;
  - a localização do sistema no Android ≤ 11.
- **Implementação, em ordem** (pastas pela tabela do `CLAUDE.md`):
  1. **`backend`:**
     - primeiro o contrato em `packages/shared/src/proximity.ts` e `connections.ts`, com os testes do shared;
     - depois a API: `apps/api/src/modules/proximity/` (store com canal, `recordTouch`/`markTouchPair`/`hasTouchPair`, script Lua e fake em memória; serviço com os dois tokens, `resolve` só QR e `touches`; controller; limite `touches`), `apps/api/src/modules/connections/` (canal e par no pedido, aceite por método), `apps/api/src/modules/dev/` e `apps/api/src/config/env.schema.ts`, com testes unitários;
     - nenhum repositório muda.
  2. **`dados`:** nada (sem migration nem SQL novo). Só entra se o `backend` precisar mudar o `findNearby`, o que não é esperado.
  3. **Em paralelo, com pastas disjuntas:**
     - `frontend`, depois do `ux.md` atualizado: `apps/mobile/modules/sussurro-proximity/**` (potência e campo TX por parâmetro, `txPower` no evento, intervalo por parâmetro, `locationServices` e modelo nas capacidades), `apps/mobile/src/features/connect/**` (`touch-calibration.ts`, `touch-detector.ts`, `useTouch` no lugar de `useNearby`, dois tokens, aceite `ble` sem token, varredura contínua, QR com `qrToken`), `apps/mobile/src/app/dev/` (calibração) e o texto do `app.plugin.js`;
     - `testes`, com o e2e da API: `apps/api/test/e2e/` (`proximity`, `connections`, `dev-routes`, `privacy-canary`, `routes` e o adaptador Valkey em `real-services`).
  4. **`testes`:** regressão do app, mutação nas regras novas (canal, par, mútuo, janela, revelação) e os casos no `docs/equipe/testes.md`; dá o veredito.
  5. **`seguranca`** revisa o diff inteiro, e **`ux-ui`** revisa a tela.
  6. **Tech Lead:**
     - README, backlog (4.1-B e 4.4 reescrita) e `PROJETO.md`;
     - a Política no site, fora do repositório, com o PO;
     - depois do build EAS autorizado: o spike 4.1-B, o ajuste do `touch-calibration.ts` (`frontend`) e os MAN-* de novo.

## Decisões do PO (tomadas em 2026-10-30)

O PO aprovou esta ADR e aceitou todas as recomendações. As alternativas descartadas ficam registradas.

1. **Fluxo depois do encosto: decidido (a) + (b).**
   - (a) cartão → "Conectar" → folha e aceite do outro;
   - (b) se os dois tocarem "Conectar", a conexão sai na hora.
   - Descartada: (c) conexão automática ao encostar, porque conecta sem conferir quem é e por acidente.
2. **Revelação no encosto: decidida a simétrica.** Os dois veem o cartão um do outro depois do encosto mútuo.
   - Descartada: a revelação cega até o aceite.
3. **Critério do spike e par reprovado: decidido.**
   - **Critério:** pelo menos 95% de encostos casados em até 3 s e nenhum `encostado` a 30 cm ou mais, por par e por capa.
   - **Par reprovado:** usa o QR.
   - Descartado: afrouxar o limiar.
4. **Android ≤ 11: mantido**, com o estado "ligue a localização do sistema" e o QR.
   - Descartado: subir o piso para Android 12.
5. **Telemetria de calibração em produção: nenhuma** na v1.
6. **Atualização OTA da calibração (`expo-updates`): não por agora.**
7. **Pré-requisitos do spike:**
   - o build EAS de desenvolvimento está autorizado;
   - o PO vai criar a conta Apple Developer para os builds de iOS;
   - os aparelhos da matriz e as três capas continuam necessários.
8. **Texto da Política de Privacidade:** aprovado o texto da `arquitetura.md` §15, inclusive o aviso do prefixo fixo.

## Fontes (consultadas em 2026-10-30)

1. Apple, HCE-based contactless NFC transactions for apps in the EEA: https://developer.apple.com/support/hce-transactions-in-apps
2. Apple, Core Bluetooth Programming Guide, "Performing Common Peripheral Role Tasks" (anúncio só com `LocalName` e `ServiceUUIDs`): https://developer.apple.com/library/ios/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/PerformingCommonPeripheralRoleTasks/PerformingCommonPeripheralRoleTasks.html
3. Apple Developer Forums, chave de TX Power recusada no anúncio: https://developer.apple.com/forums/thread/659541
4. Android, `AdvertisingSetParameters` (`TX_POWER_ULTRA_LOW` "restrict the visibility range", -21/-15/-7/+1): https://developer.android.com/reference/kotlin/android/bluetooth/le/AdvertisingSetParameters ; mapeamento de `AdvertiseSettings` para dBm no `BluetoothLeAdvertiser` (AOSP, Android 9): https://code.yawk.at/android/android-9.0.0_r35/android/bluetooth/le/BluetoothLeAdvertiser.java
5. AOSP, `ScanRecord.getTxPowerLevel()` (`Integer.MIN_VALUE` sem o campo; perda = TX − RSSI): https://code.yawk.at/android/android-9.0.0_r35/android/bluetooth/le/ScanRecord.java
6. Apple, `CBAdvertisementDataTxPowerLevelKey` (presente se o periférico anuncia a potência; estimar a perda): https://developer.apple.com/documentation/corebluetooth/cbadvertisementdatatxpowerlevelkey
7. Android, calibração de "Presence" (mediana a 1 m entre -65 e -45 dBm; amplitude ≤ 18 dB; propriedades de correção Rx/Tx): https://source.android.com/docs/core/connect/presence-requirements
8. D. Leith e S. Farrell, "Coronavirus Contact Tracing: Evaluating The Potential Of Using Bluetooth Received Signal Strength For Proximity Detection": https://arxiv.org/abs/2006.06822
9. Cabeçalho do `CBCentralManagerDelegate` (RSSI 127 = indisponível), reproduzido em: https://docs.rs/objc2-core-bluetooth/latest/objc2_core_bluetooth/trait.CBCentralManagerDelegate.html
10. Limite de inícios de varredura no Android 7+: https://punchthrough.com/android-ble-scan-errors/ e https://proandroiddev.com/to-find-a-beacon-without-losing-it-my-journey-into-a-realm-of-bluetooth-low-energy-on-android-aa3e2c2923aa
11. Android, permissões de Bluetooth (`ACCESS_FINE_LOCATION` no Android ≤ 11; `neverForLocation` filtra alguns beacons): https://developer.android.com/develop/connectivity/bluetooth/bt-permissions
12. Punch Through, "Why Your BLE Scan Returns No Results on Android" (localização do sistema ligada no Android 6 a 11): https://punchthrough.com/ble-scan-returns-no-results-on-android/
13. Expo FAQ (Android 7+): https://docs.expo.dev/faq/
14. Apple, Personal Safety User Guide, NameDrop (segurar o iPhone a poucos centímetros do outro): https://support.apple.com/en-ph/guide/personal-safety/ips97e16d3b1/web
15. Apple Developer Forums, thread 802004 (NameDrop com os celulares lado a lado; "there's no API to control NameDrop"): https://developer.apple.com/forums/thread/802004
16. Desligar o NameDrop, escolher "Só receber" e cancelar afastando ou bloqueando (fontes secundárias): https://www.tomsguide.com/how-to/how-to-disable-namedrop-on-iphone e https://iphonelife.com/content/exchange-contact-info-namedrop

Sem fonte pública e a medir no spike: a potência real do anúncio do iPhone (por isso `iosAdvertiserTxDbm` é provisório) e se o campo TX Power do Android reflete o nível pedido em todos os chips (por isso `trustAdvertisedTx`).
