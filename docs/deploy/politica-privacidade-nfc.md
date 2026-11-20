# Política de Privacidade: texto novo da conexão presencial (NFC + QR code)

> Preparado em 2026-11-19 para o PO colar no site (`https://sussurro-site.vercel.app/privacidade`; o código do site fica fora deste repositório). Base: ADR 0013, `docs/deploy/lojas.md` (tabela de permissões) e o código da API (`apps/api/src/modules/proximity`).
>
> **Por que é urgente:** a página publicada, lida em 2026-11-19, ainda diz que a conexão usa Bluetooth e lista as permissões "Bluetooth" e "Localização (só Android 11 ou anterior)". O app enviado às lojas não pede mais nenhuma das duas: o job `native` do CI confere o manifesto de release. Política e app divergentes são motivo comum de rejeição na App Store e no Google Play (Data safety). Publique o texto novo **antes** de enviar o build.

## O que trocar

Os trechos abaixo substituem os da página atual, seção por seção. O resto da política não muda.

### 1. Resumo: trocar a frase da conexão presencial

**Hoje:** "A conexão presencial usa Bluetooth, com um código aleatório que muda a cada 20 segundos."

**Novo:** "A conexão presencial usa NFC (encostando os celulares) ou QR code, com um código aleatório que muda a cada 20 segundos."

### 3. Dados que tratamos: linha "Suas relações"

**Hoje:** "Conexões (com a data e o meio usado, Bluetooth ou QR code)"

**Novo:** "Conexões (com a data e o meio usado, NFC ou QR code)"

### 5. Seção inteira: novo título e texto

**Título novo:** "5. Conexão presencial: NFC e QR code"

**Texto novo:**

> Para se conectar, as duas pessoas precisam estar juntas, com a tela Conectar aberta.
>
> - **Código temporário.** Ao abrir a tela Conectar, o app recebe do servidor um código aleatório, que vale 30 segundos e é trocado a cada 20 segundos. O código não traz o seu nome, o seu @ nem nada que identifique o aparelho. Só o servidor do Sussurro consegue ligar o código a uma conta. O servidor guarda os códigos só em forma irreversível (hash), por no máximo 2 minutos.
> - **QR code.** A tela mostra esse código num QR code, para a outra pessoa ler com a câmera.
> - **NFC.** No Android, o mesmo código também pode ser lido encostando os celulares. O celular só transmite por NFC com a tela Conectar aberta, o app em primeiro plano e o aparelho desbloqueado, e cada código vale por no máximo 30 segundos. Ao fechar a tela ou sair do app, ele para de transmitir. O iPhone lê o código por NFC, mas não transmite: quem tem iPhone mostra o QR code.
> - **Confirmação dos dois lados.** A conexão só é criada quando as duas pessoas confirmam, e quem confirma precisa ler o código de quem pediu. Quem recebe um pedido vê o perfil da outra pessoa e pode recusar, bloquear ou denunciar.
>
> O app não mede distância, não procura pessoas por perto e não usa Bluetooth nem a sua localização.

**Sai** (não vale mais): "O Bluetooth do Sussurro só funciona com a tela Conectar aberta…", "ele para de anunciar e de procurar" e o parágrafo da lista "Por perto" ("usa só a força do sinal e mostra 'bem perto' ou 'por perto'").

### 6. Permissões do celular: trocar duas linhas da tabela

- **No lugar da linha "Bluetooth"**, entra:

  | Permissão | Para quê |
  |---|---|
  | NFC | Trocar o código de conexão encostando os celulares, só com a tela Conectar aberta. No Android é uma permissão automática, sem pedido na tela. |

- **Sai a linha** "Localização (só Android 11 ou anterior)".
- As linhas "Câmera", "Fotos e vídeos" e "Notificações (opcional)" continuam como estão, assim como o texto depois da tabela.

## Depois de publicar

- [ ] Atualizar a data da última alteração no fim da página ("Mudanças e contato").
- [ ] Conferir que nenhum trecho ainda cita Bluetooth, "Por perto" ou a permissão de localização.
- [ ] Na App Store Connect, conferir em App Privacy que não há "Location" declarada. No Google Play, conferir em Data safety: "localização: não coletada" (`lojas.md`).
- [ ] Revisar com o jurídico ou o encarregado (DPO), se houver, antes de publicar. Este texto descreve o funcionamento técnico, não é parecer jurídico.
