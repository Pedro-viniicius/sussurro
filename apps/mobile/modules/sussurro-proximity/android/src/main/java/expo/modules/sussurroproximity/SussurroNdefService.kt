package expo.modules.sussurroproximity

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

// Emulação de cartão (HCE) do código de conexão (ADR 0013 §4): responde como uma NFC Forum Type 4
// Tag só de leitura. O leitor seleciona o AID NDEF (D2760000850101), o CC (E103) e o arquivo NDEF
// (E104), e lê com READ BINARY. Sem código ativo (tela Conectar fechada, app em background), tudo
// responde 6A82 e o leitor não recebe nada. O sistema só chama este serviço com o aparelho
// desbloqueado (`requireDeviceUnlock` no `sussurro_apduservice.xml`).

class SussurroNdefService : HostApduService() {
  private enum class Selected { NONE, CC, NDEF }

  // Estado de uma única leitura (o sistema chama este serviço numa thread só). Zera no
  // `onDeactivated`: nada persiste entre leituras.
  private var applicationSelected = false
  private var selected = Selected.NONE

  /** Cópia do arquivo NDEF feita no SELECT E104: a troca do token no meio não mistura bytes. */
  private var ndefSnapshot: ByteArray? = null

  override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
    val apdu = commandApdu ?: return SW_INS_NOT_SUPPORTED
    if (apdu.size < 4 || apdu[0] != 0x00.toByte()) {
      return SW_INS_NOT_SUPPORTED
    }
    return when (apdu[1]) {
      INS_SELECT -> select(apdu)
      INS_READ_BINARY -> readBinary(apdu)
      else -> SW_INS_NOT_SUPPORTED
    }
  }

  override fun onDeactivated(reason: Int) {
    applicationSelected = false
    selected = Selected.NONE
    ndefSnapshot = null
  }

  private fun select(apdu: ByteArray): ByteArray {
    val p1 = apdu[2].toInt() and 0xFF
    val data = commandData(apdu) ?: return SW_FILE_NOT_FOUND
    return when (p1) {
      // SELECT por nome (AID).
      0x04 -> {
        if (!data.contentEquals(SussurroNdef.NDEF_AID) || SussurroNfcPayload.ndefFile == null) {
          reset()
          SW_FILE_NOT_FOUND
        } else {
          applicationSelected = true
          selected = Selected.NONE
          SW_OK
        }
      }
      // SELECT por identificador de arquivo (EF).
      0x00 -> selectFile(data)
      else -> SW_FILE_NOT_FOUND
    }
  }

  private fun selectFile(fileId: ByteArray): ByteArray {
    if (!applicationSelected) {
      return SW_FILE_NOT_FOUND
    }
    return when {
      fileId.contentEquals(SussurroNdef.CC_FILE_ID) -> {
        selected = Selected.CC
        SW_OK
      }
      fileId.contentEquals(SussurroNdef.NDEF_FILE_ID) -> {
        val file = SussurroNfcPayload.ndefFile
        if (file == null) {
          reset()
          SW_FILE_NOT_FOUND
        } else {
          ndefSnapshot = file
          selected = Selected.NDEF
          SW_OK
        }
      }
      else -> {
        selected = Selected.NONE
        SW_FILE_NOT_FOUND
      }
    }
  }

  private fun readBinary(apdu: ByteArray): ByteArray {
    val file = when (selected) {
      Selected.CC -> CAPABILITY_CONTAINER
      // O código pode ter sido apagado depois do SELECT (a tela fechou): para de responder.
      Selected.NDEF -> if (SussurroNfcPayload.ndefFile == null) null else ndefSnapshot
      Selected.NONE -> null
    } ?: return SW_FILE_NOT_FOUND
    val offset = ((apdu[2].toInt() and 0x7F) shl 8) or (apdu[3].toInt() and 0xFF)
    // Le: o 5º byte (0 = 256). Sem Le, devolve o que couber no MLe.
    val le = if (apdu.size >= 5) {
      (apdu[4].toInt() and 0xFF).let { if (it == 0) 256 else it }
    } else {
      SussurroNdef.MAX_READ_LENGTH
    }
    if (offset > file.size) {
      return SW_WRONG_OFFSET
    }
    val end = minOf(file.size, offset + le)
    return file.copyOfRange(offset, end) + SW_OK
  }

  private fun reset() {
    applicationSelected = false
    selected = Selected.NONE
    ndefSnapshot = null
  }

  /** Os bytes de dados (Lc + dados) de um comando case 3/4; `null` se o tamanho não bate. */
  private fun commandData(apdu: ByteArray): ByteArray? {
    if (apdu.size < 5) {
      return null
    }
    val lc = apdu[4].toInt() and 0xFF
    if (lc == 0 || apdu.size < 5 + lc) {
      return null
    }
    return apdu.copyOfRange(5, 5 + lc)
  }

  private companion object {
    val INS_SELECT: Byte = 0xA4.toByte()
    val INS_READ_BINARY: Byte = 0xB0.toByte()

    val SW_OK = byteArrayOf(0x90.toByte(), 0x00)
    val SW_FILE_NOT_FOUND = byteArrayOf(0x6A, 0x82.toByte())
    val SW_INS_NOT_SUPPORTED = byteArrayOf(0x6D, 0x00)

    /** Offset além do fim do arquivo (ISO 7816-4: "wrong parameters P1-P2"). */
    val SW_WRONG_OFFSET = byteArrayOf(0x6B, 0x00)

    val CAPABILITY_CONTAINER: ByteArray = SussurroNdef.buildCapabilityContainer()
  }
}
