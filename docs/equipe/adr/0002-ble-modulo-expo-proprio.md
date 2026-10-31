# ADR 0002: BLE com módulo Expo próprio (anúncio + varredura, sem GATT)

- Status: proposto (diverge do briefing, seção 4.2/5) · Data: 2026-10-29
- Em parte substituída pela ADR 0012 (2026-10-30, Conectar encostando). Mudam:
  - a potência do anúncio no Android (configurável, `ULTRA_LOW` como padrão inicial) e o campo TX Power no anúncio;
  - o evento da varredura (`txPower`) e o intervalo vindo do TypeScript;
  - as capacidades (`locationServices` e modelo);
  - o aparelho que não anuncia, que vai direto para o QR.

  Depois, o adendo A1 da ADR 0012 (2026-10-30) tirou o campo TX Power do anúncio e do evento da varredura (`{uuid, rssi}`) e mudou a potência inicial do Android para `HIGH`.

  O módulo próprio, o UUID de 128 bits e o esquema sem GATT continuam.

## Contexto
A especificação prevê `react-native-ble-plx` para trocar tokens entre dois celulares. Fatos verificados:
- `react-native-ble-plx` só atua como **central**. O próprio README lista "comunicação entre celulares (suporte a peripheral)" como fora do escopo. A opção `modes: ["peripheral"]` do config plugin só adiciona background modes ao Info.plist e não faz o aparelho anunciar.
- O upstream está no 3.5.1 (fev/2026). Existe um fork comunitário (`@sfourdrinier/react-native-ble-plx`) que declara o upstream "efetivamente sem manutenção para stacks modernas" e exige SDK 57+. A reescrita v4 para TurboModules segue como PR em rascunho.
- Libs com papel peripheral compatíveis com Expo: `munim-bluetooth` (Nitro, ~25 estrelas, Apache-2.0), `expo-ble-kit` (1 estrela) e `react-native-ble-lite`. Todas têm adoção baixa e bus factor 1.
- No iOS em foreground, o `CBPeripheralManager` só anuncia `LocalName` e `ServiceUUIDs`, com até 28 bytes. **Service data e manufacturer data não estão disponíveis.** Em background, os UUIDs vão para a "overflow area" e o nome não é anunciado.
- O produto só exige descoberta com a tela Conectar aberta, ou seja, em foreground nos dois aparelhos.

## Decisão
Criar um **módulo Expo local** `apps/mobile/modules/sussurro-proximity` (Expo Modules API, Swift + Kotlin, com config plugin para permissões) que faz as duas coisas:
- `startAdvertising(tokenBytes)` / `stopAdvertising()`: anuncia **um UUID de serviço de 128 bits = prefixo fixo de 4 bytes + token de 12 bytes**. Sem nome local e sem nome do aparelho. Os 18 bytes cabem no pacote principal do iOS e do Android.
- `startScan()` / `stopScan()` emitem eventos `{token, rssi}` quando o UUID tem o prefixo. Android: `ScanFilter` com máscara. iOS: varredura sem filtro em foreground, filtro em código, `AllowDuplicates` ligado.
- `getCapabilities()` informa se o aparelho anuncia (`isMultipleAdvertisementSupported`) e o estado e a permissão do Bluetooth.
- **Sem conexão GATT.** O esquema é connectionless, então não há o erro 133 do Android, a descoberta é mais rápida com várias pessoas por perto e o nome GAP do aparelho não fica exposto.
- Permissões: iOS `NSBluetoothAlwaysUsageDescription`. Android 12+: `BLUETOOTH_SCAN` (`neverForLocation`), `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`. Android <= 11: `ACCESS_FINE_LOCATION` para a varredura.

Com isso o `react-native-ble-plx` **sai da v1**: precisaríamos do módulo nativo de qualquer forma, e a varredura connectionless são poucas linhas por plataforma.

## Alternativas
1. **ble-plx (varredura) + módulo próprio só para anúncio**: segue a especificação à risca e tem a mesma viabilidade. Custa dois stacks BLE com plugins e permissões separados, e a manutenção do ble-plx na New Architecture/RN 0.88 é incerta. Aceitável se o PO fizer questão.
2. **`munim-bluetooth`**: tem os dois papéis e GATT, mas é uma dependência crítica de baixa adoção e usa Nitro em vez da Expo Modules API. Fica como plano B do spike.
3. **Token no `LocalName`**: no iOS sobram cerca de 8 bytes ao lado de um UUID de 128 bits e há problemas conhecidos de cache e truncamento do nome. Descartado.
4. **UUID fixo + token em característica GATT**: aceita tokens maiores, mas exige conectar, o que é lento e frágil no Android. Fica como fallback dentro do mesmo módulo se o teste de campo mostrar problema com UUIDs dinâmicos.
5. **NFC**: inviável no iOS (já descartado pelo PO). **Nearby Interaction/UWB**: fora da v1.

## Consequências
- O token de proximidade tem **12 bytes (96 bits)**. Isso é suficiente: com TTL de 30 s e rate limit, força bruta é impraticável (ADR 0003).
- O time mantém cerca de 300 linhas nativas. É preciso um spike no início da Fase 4 com matriz de aparelhos (2 iPhones, Samsung e outro Android).
- Privacidade: o anúncio não tem nada estável. O token muda a cada 20 s, o MAC é aleatório pelo SO, o anúncio só existe com a tela aberta e não há nome.
- Não funciona no simulador iOS. Testar exige dois aparelhos físicos, e o QR cobre o teste individual.
