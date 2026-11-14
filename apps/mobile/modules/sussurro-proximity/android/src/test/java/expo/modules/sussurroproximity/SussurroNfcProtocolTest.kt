package expo.modules.sussurroproximity

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

// NFC-10 a NFC-17 (ADR 0013 §4): o leitor Type 4 do módulo (`readType4NdefFile`) conversa com o
// `SussurroNdefService` (HCE) de verdade, APDU por APDU, sem aparelho. É o mesmo código que roda
// num Android lendo outro Android por IsoDep. O caminho `Ndef` do sistema e o Core NFC do iPhone
// leem o mesmo arquivo NDEF; esses só se confirmam em aparelho (MAN-NFC-01 e 02).
class SussurroNfcProtocolTest {
  private val uri = "sussurro://c/AbCdEfGh_-123456"
  private lateinit var service: SussurroNdefService

  @Before
  fun setUp() {
    service = SussurroNdefService()
    SussurroNfcPayload.foreground = true
  }

  @After
  fun tearDown() {
    SussurroNfcPayload.foreground = false
  }

  private fun read(maxChunk: Int = SussurroNdef.MAX_READ_LENGTH, maxApdus: Int = 16): String? {
    var apdus = 0
    val body = SussurroNdef.readType4NdefFile(maxChunk, 256) { command ->
      if (apdus >= maxApdus) null else service.processCommandApdu(command, null).also { apdus++ }
    } ?: return null
    service.onDeactivated(0)
    return SussurroNdef.sussurroUriFromMessage(body)
  }

  @Test
  fun `NFC-10 o leitor recebe o codigo emitido pelo HCE`() {
    SussurroNfcPayload.set(uri)
    assertEquals(uri, read())
  }

  @Test
  fun `NFC-11 leitura em blocos pequenos monta a mesma URI`() {
    SussurroNfcPayload.set(uri)
    assertEquals(uri, read(maxChunk = 5, maxApdus = 32))
  }

  @Test
  fun `NFC-12 sem codigo ativo o HCE responde 6A82 e o leitor nao recebe nada`() {
    SussurroNfcPayload.set(null)
    assertNull(read())
    val response = service.processCommandApdu(SussurroNdef.selectAidCommand(), null)
    assertEquals(listOf(0x6A.toByte(), 0x82.toByte()), response.toList())
  }

  @Test
  fun `NFC-13 fora do primeiro plano a gravacao e ignorada`() {
    SussurroNfcPayload.foreground = false
    SussurroNfcPayload.set(uri)
    SussurroNfcPayload.foreground = true
    assertNull(read())
  }

  @Test
  fun `NFC-14 ir para o background apaga o codigo ja emitido`() {
    SussurroNfcPayload.set(uri)
    SussurroNfcPayload.foreground = false
    SussurroNfcPayload.foreground = true
    assertNull(read())
  }

  @Test
  fun `NFC-15 o leitor desiste no limite de APDUs`() {
    SussurroNfcPayload.set(uri)
    assertNull(read(maxChunk = 1, maxApdus = 16))
  }

  @Test
  fun `NFC-16 so URI do Sussurro no formato exato chega ao app`() {
    val other = SussurroNdef.buildMessage("https://example.com/c/AbCdEfGh_-123456")
    assertNull(SussurroNdef.sussurroUriFromMessage(other))
    val longer = SussurroNdef.buildMessage(uri + "x")
    assertNull(SussurroNdef.sussurroUriFromMessage(longer))
    assertEquals(uri, SussurroNdef.sussurroUriFromMessage(SussurroNdef.buildMessage(uri)))
  }

  @Test
  fun `NFC-17 NLEN malicioso acima do maximo e recusado`() {
    val body = SussurroNdef.readType4NdefFile(0x7F, 256) { command ->
      when (command[1]) {
        0xB0.toByte() -> byteArrayOf(0x7F, 0xFF.toByte(), 0x90.toByte(), 0x00)
        else -> byteArrayOf(0x90.toByte(), 0x00)
      }
    }
    assertNull(body)
  }
}
