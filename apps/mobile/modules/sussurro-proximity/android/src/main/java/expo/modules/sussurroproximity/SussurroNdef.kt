package expo.modules.sussurroproximity

import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.os.SystemClock

// NDEF do código de conexão (ADR 0013 §1 e §4): uma mensagem com um único registro URI
// (TNF well-known, tipo "U") com o `sussurro://c/{token}` inteiro, prefixo 0x00 (sem abreviação).
// O mesmo arquivo é servido pelo `SussurroNdefService` (HCE) e lido pelo módulo.

/**
 * Código emitido agora pelo HCE. Só em memória: some quando o processo morre. Só aceita código com
 * o app em primeiro plano e cada código vale [PAYLOAD_TTL_MS] (o JS reemite a cada renovação, uns
 * 20 s); depois disso o serviço responde 6A82.
 */
object SussurroNfcPayload {
  /** O app só emite e só aceita códigos com este prefixo (ADR 0013 §6, N2). */
  const val URI_PREFIX = "sussurro://c/"

  /** Tamanho do token do código (ADR 0013 §1). */
  const val TOKEN_LENGTH = 16

  /** A URI inteira, de tamanho exato: o prefixo + 16 caracteres base64url. */
  private val URI_PATTERN = Regex("^sussurro://c/[A-Za-z0-9_-]{16}$")

  /** Tamanho máximo do arquivo NDEF (NLEN + mensagem), anunciado no CC. */
  const val MAX_NDEF_FILE_SIZE = 0x0200

  /** Validade de um código gravado (relógio monotônico). */
  const val PAYLOAD_TTL_MS = 30_000L

  /** Trava única: a gravação (thread do JS) e o background (thread principal) não se cruzam. */
  private val lock = Any()

  /**
   * Ligada e desligada pelo módulo nos eventos de primeiro plano e background da Activity. Desligar
   * também apaga o código, dentro da mesma trava.
   */
  @Volatile
  var foreground: Boolean = false
    set(value) {
      synchronized(lock) {
        field = value
        if (!value) entry = null
      }
    }

  /** Arquivo NDEF e o seu prazo, trocados juntos (um só campo volátil). */
  private class Entry(val file: ByteArray, val expiresAt: Long)

  @Volatile
  private var entry: Entry? = null

  /** `true` só para `sussurro://c/` + 16 caracteres [A-Za-z0-9_-], nada antes nem depois. */
  fun isSussurroUri(uri: String?): Boolean =
    uri != null &&
      uri.length == URI_PREFIX.length + TOKEN_LENGTH &&
      URI_PATTERN.matches(uri)

  /** Arquivo NDEF pronto (NLEN + mensagem), ou `null` sem emissão ou com o código vencido. */
  val ndefFile: ByteArray?
    get() {
      if (!foreground) return null
      val current = entry ?: return null
      if (SystemClock.elapsedRealtime() >= current.expiresAt) {
        entry = null
        return null
      }
      return current.file
    }

  /**
   * Grava (ou apaga, com `null`) o código emitido. Fora do primeiro plano a gravação é ignorada
   * (e o que havia é apagado). Conteúdo fora do formato exato é recusado (o JS já valida o token;
   * aqui é a última barreira).
   */
  fun set(uri: String?) {
    val file =
      if (uri == null) {
        null
      } else {
        require(isSussurroUri(uri)) { "Código fora do formato $URI_PREFIX{token}" }
        SussurroNdef.buildNdefFile(uri).also {
          require(it.size <= MAX_NDEF_FILE_SIZE) { "Código grande demais para o NFC" }
        }
      }
    synchronized(lock) {
      entry =
        if (file == null || !foreground) null
        else Entry(file, SystemClock.elapsedRealtime() + PAYLOAD_TTL_MS)
    }
  }

  fun clear() {
    synchronized(lock) { entry = null }
  }
}

object SussurroNdef {
  /** AID da aplicação NDEF do NFC Forum Type 4 Tag. */
  val NDEF_AID: ByteArray = hex("D2760000850101")
  val CC_FILE_ID: ByteArray = hex("E103")
  val NDEF_FILE_ID: ByteArray = hex("E104")

  /** Maior trecho pedido num READ BINARY (MLe do CC); o arquivo do Sussurro tem uns 36 bytes. */
  const val MAX_READ_LENGTH = 0x7F

  /** Abreviações de URI do NFC Forum (RTD URI 1.0, 0x00 a 0x23). */
  private val URI_PREFIXES = arrayOf(
    "", "http://www.", "https://www.", "http://", "https://", "tel:", "mailto:",
    "ftp://anonymous:anonymous@", "ftp://ftp.", "ftps://", "sftp://", "smb://", "nfs://",
    "ftp://", "dav://", "news:", "telnet://", "imap:", "rtsp://", "urn:", "pop:", "sip:", "sips:",
    "tftp:", "btspp://", "btl2cap://", "btgoep://", "tcpobex://", "irdaobex://", "file://",
    "urn:epc:id:", "urn:epc:tag:", "urn:epc:pat:", "urn:epc:raw:", "urn:epc:", "urn:nfc:"
  )

  /** Mensagem NDEF de 1 registro URI, com o prefixo 0x00 e a URI inteira em UTF-8. */
  fun buildMessage(uri: String): ByteArray {
    val payload = byteArrayOf(0x00) + uri.toByteArray(Charsets.UTF_8)
    val type = byteArrayOf('U'.code.toByte())
    // MB | ME | TNF well-known (0x01); SR (0x10) quando o payload cabe em 1 byte.
    return if (payload.size <= 0xFF) {
      byteArrayOf(0xD1.toByte(), type.size.toByte(), payload.size.toByte()) + type + payload
    } else {
      val length = payload.size
      byteArrayOf(
        0xC1.toByte(),
        type.size.toByte(),
        (length ushr 24).toByte(),
        (length ushr 16).toByte(),
        (length ushr 8).toByte(),
        length.toByte()
      ) + type + payload
    }
  }

  /** Arquivo NDEF do Type 4 Tag: NLEN (2 bytes, big-endian) + a mensagem. */
  fun buildNdefFile(uri: String): ByteArray {
    val message = buildMessage(uri)
    return byteArrayOf((message.size ushr 8).toByte(), message.size.toByte()) + message
  }

  /**
   * Capability Container (15 bytes): CCLEN 000F, versão 2.0, MLe e MLc, e o TLV do arquivo NDEF
   * (E104, tamanho máximo, leitura livre 00, escrita proibida FF).
   */
  fun buildCapabilityContainer(): ByteArray = byteArrayOf(
    0x00, 0x0F,
    0x20,
    0x00, MAX_READ_LENGTH.toByte(),
    0x00, MAX_READ_LENGTH.toByte(),
    0x04, 0x06,
    NDEF_FILE_ID[0], NDEF_FILE_ID[1],
    (SussurroNfcPayload.MAX_NDEF_FILE_SIZE ushr 8).toByte(),
    SussurroNfcPayload.MAX_NDEF_FILE_SIZE.toByte(),
    0x00,
    0xFF.toByte()
  )

  /** A URI do 1º registro URI (TNF well-known, tipo "U") da mensagem, ou `null`. */
  fun firstUri(message: NdefMessage?): String? {
    val record = message?.records?.firstOrNull { isUriRecord(it) } ?: return null
    return decodeUriPayload(record.payload)
  }

  private fun isUriRecord(record: NdefRecord): Boolean =
    record.tnf == NdefRecord.TNF_WELL_KNOWN && record.type.contentEquals(NdefRecord.RTD_URI)

  /** Payload do registro URI: 1 byte de abreviação + o resto em UTF-8. */
  fun decodeUriPayload(payload: ByteArray?): String? {
    if (payload == null || payload.isEmpty()) {
      return null
    }
    val index = payload[0].toInt() and 0xFF
    if (index >= URI_PREFIXES.size) {
      return null
    }
    return URI_PREFIXES[index] + String(payload, 1, payload.size - 1, Charsets.UTF_8)
  }

  /** Só códigos do Sussurro, no formato exato, chegam ao JS (ADR 0013 §6, N2). */
  fun sussurroUri(message: NdefMessage?): String? =
    firstUri(message)?.takeIf { SussurroNfcPayload.isSussurroUri(it) }

  // --- Leitor Type 4 (IsoDep), sem dependência do Android: testável na JVM ----------------------

  fun selectAidCommand(): ByteArray =
    byteArrayOf(0x00, 0xA4.toByte(), 0x04, 0x00, NDEF_AID.size.toByte()) + NDEF_AID +
      byteArrayOf(0x00)

  fun selectFileCommand(fileId: ByteArray): ByteArray =
    byteArrayOf(0x00, 0xA4.toByte(), 0x00, 0x0C, fileId.size.toByte()) + fileId

  fun readBinaryCommand(offset: Int, length: Int): ByteArray =
    byteArrayOf(
      0x00,
      0xB0.toByte(),
      ((offset ushr 8) and 0x7F).toByte(),
      (offset and 0xFF).toByte(),
      length.toByte()
    )

  fun isOk(response: ByteArray?): Boolean =
    response != null && response.size >= 2 &&
      response[response.size - 2] == 0x90.toByte() && response[response.size - 1] == 0x00.toByte()

  /**
   * O diálogo de um leitor NFC Forum Type 4: SELECT AID, SELECT E104, READ do NLEN e o corpo em
   * blocos de até [maxChunk]. Devolve a mensagem NDEF (sem o NLEN), ou `null` em qualquer falha.
   * [transceive] devolve `null` quando o leitor desiste (limite de APDUs ou de tempo).
   */
  fun readType4NdefFile(
    maxChunk: Int,
    maxNdefLength: Int,
    transceive: (ByteArray) -> ByteArray?
  ): ByteArray? {
    if (maxChunk <= 0) return null
    if (!isOk(transceive(selectAidCommand()))) return null
    if (!isOk(transceive(selectFileCommand(NDEF_FILE_ID)))) return null
    val nlenResponse = transceive(readBinaryCommand(0, 2)) ?: return null
    if (!isOk(nlenResponse) || nlenResponse.size != 4) return null
    val nlen = ((nlenResponse[0].toInt() and 0xFF) shl 8) or (nlenResponse[1].toInt() and 0xFF)
    if (nlen == 0 || nlen > maxNdefLength) return null
    val body = ByteArray(nlen)
    var read = 0
    while (read < nlen) {
      val length = minOf(maxChunk, nlen - read)
      val response = transceive(readBinaryCommand(2 + read, length))
      if (response == null || !isOk(response) || response.size < 3) return null
      val count = minOf(response.size - 2, nlen - read)
      System.arraycopy(response, 0, body, read, count)
      read += count
    }
    return body
  }

  /**
   * A URI do 1º registro da mensagem NDEF crua, se ele for um registro URI curto (SR) bem formado,
   * no formato exato do Sussurro. Sem `NdefMessage`: o mesmo código roda no aparelho e na JVM.
   */
  fun sussurroUriFromMessage(message: ByteArray): String? {
    if (message.size < 3) return null
    val header = message[0].toInt() and 0xFF
    val tnf = header and 0x07
    val shortRecord = header and 0x10 != 0
    val hasId = header and 0x08 != 0
    if (tnf != 0x01 || !shortRecord) return null
    val typeLength = message[1].toInt() and 0xFF
    val payloadLength = message[2].toInt() and 0xFF
    var index = 3
    val idLength = if (hasId) (message.getOrNull(index++)?.toInt() ?: return null) and 0xFF else 0
    if (typeLength != 1 || index + typeLength + idLength + payloadLength > message.size) return null
    if (message[index] != 'U'.code.toByte()) return null
    index += typeLength + idLength
    val uri = decodeUriPayload(message.copyOfRange(index, index + payloadLength))
    return uri?.takeIf { SussurroNfcPayload.isSussurroUri(it) }
  }

  fun hex(value: String): ByteArray =
    ByteArray(value.length / 2) { index ->
      value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
}
