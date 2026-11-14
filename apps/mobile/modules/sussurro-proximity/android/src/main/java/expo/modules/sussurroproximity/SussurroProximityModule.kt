package expo.modules.sussurroproximity

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.nfc.FormatException
import android.nfc.NdefMessage
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.cardemulation.CardEmulation
import android.nfc.tech.IsoDep
import android.nfc.tech.Ndef
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException

// Módulo `sussurro-proximity` (ADR 0013 §4): o código de conexão `sussurro://c/{token}` por NFC.
// - Emitir: o JS grava o código em `SussurroNfcPayload` e o `SussurroNdefService` (HCE) o entrega
//   como uma Type 4 Tag. O código fica só em memória, só é aceito com o app em primeiro plano, vence
//   em 30 s (o JS reemite a cada renovação) e é apagado ao ir para o background e no `OnDestroy`.
// - Ler: reader mode na Activity atual, só com o app em primeiro plano. Enquanto lê, este aparelho
//   não é lido por outro (o sistema desliga a emulação de cartão).
// Sem Bluetooth, sem localização e sem permissão em tempo de execução (a de NFC é "normal").

private const val TAG = "SussurroProximity"
private const val READ_EVENT = "onNfcRead"
private const val READ_ERROR_EVENT = "onNfcReadError"
private const val STATE_EVENT = "onNfcStateChange"

/** No máximo um evento pelo mesmo código neste intervalo (o leitor vê a tag várias vezes). */
private const val DEDUPE_MS = 1_500L

/** Intervalo da checagem de presença da tag (o padrão do sistema é 125 ms). */
private const val PRESENCE_CHECK_DELAY_MS = 250

/** Tempo máximo de cada APDU na leitura por IsoDep. */
private const val ISO_DEP_TIMEOUT_MS = 1_000

/** O que é emitido por NFC nunca passa disso (a mensagem do Sussurro tem uns 34 bytes). */
private const val MAX_NDEF_READ = 256

/** Uma leitura por IsoDep troca no máximo esta quantidade de APDUs... */
private const val ISO_DEP_MAX_APDUS = 16

/** ...e dura no máximo isto, do connect ao último READ BINARY. */
private const val ISO_DEP_TOTAL_MS = 3_000L

/**
 * Reader mode só NFC-A/B (o HCE do Android responde em ISO-DEP sobre A ou B). Sem
 * `FLAG_READER_SKIP_NDEF_CHECK`: o sistema faz a checagem NDEF e o `Ndef.get` já traz a mensagem.
 * Sem `FLAG_READER_NO_PLATFORM_SOUNDS`: o som do sistema é o retorno de que o encosto deu certo,
 * útil com os celulares costas com costas e a tela fora da vista.
 */
private const val READER_FLAGS = NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B

internal class NfcUnsupportedException :
  CodedException("ERR_NFC_UNSUPPORTED", "Este aparelho não tem NFC.", null)

internal class NfcDisabledException :
  CodedException("ERR_NFC_DISABLED", "O NFC está desligado.", null)

internal class NoActivityException :
  CodedException("ERR_NFC_NO_ACTIVITY", "O app não está em primeiro plano.", null)

internal class InvalidPayloadException(cause: Throwable) :
  CodedException("ERR_NFC_INVALID_PAYLOAD", "Código de conexão inválido para o NFC.", cause)

class SussurroProximityModule : Module() {
  /** O JS pediu para ler (o reader mode volta sozinho ao sair do background). */
  @Volatile private var wantsReading = false
  /** A Activity em que o reader mode está ligado agora. */
  @Volatile private var readerActivity: Activity? = null
  @Volatile private var lastUri: String? = null
  @Volatile private var lastUriAt = 0L
  private var stateReceiver: BroadcastReceiver? = null

  private val context: Context?
    get() = appContext.reactContext

  private val adapter: NfcAdapter?
    get() = context?.let { NfcAdapter.getDefaultAdapter(it) }

  override fun definition() = ModuleDefinition {
    Name("SussurroProximity")

    Events(READ_EVENT, READ_ERROR_EVENT, STATE_EVENT)

    OnCreate {
      // O módulo nasce no 1º acesso do JS, com o app aberto; os eventos abaixo mantêm a flag.
      SussurroNfcPayload.foreground = appContext.currentActivity != null
      registerStateReceiver()
    }

    OnDestroy {
      SussurroNfcPayload.foreground = false
      SussurroNfcPayload.clear()
      wantsReading = false
      disableReader()
      unregisterStateReceiver()
    }

    // Em background o código deixa de ser emitido e a leitura para (o JS grava o código de novo
    // quando a tela Conectar volta a ficar visível).
    OnActivityEntersBackground {
      SussurroNfcPayload.foreground = false
      clearPayload()
      disableReader()
    }

    OnActivityEntersForeground {
      SussurroNfcPayload.foreground = true
      if (wantsReading) {
        enableReader()
      }
    }

    AsyncFunction("getNfcCapabilities") {
      capabilities()
    }

    // Fora do primeiro plano a gravação é ignorada (M2): nada é emitido com o app em background.
    Function("setEmittedPayload") { uri: String? ->
      try {
        SussurroNfcPayload.set(uri)
      } catch (e: IllegalArgumentException) {
        SussurroNfcPayload.clear()
        throw InvalidPayloadException(e)
      }
      updatePreferredService(SussurroNfcPayload.ndefFile != null)
    }

    AsyncFunction("startReading") {
      val adapter = adapter ?: throw NfcUnsupportedException()
      if (!adapter.isEnabled) {
        throw NfcDisabledException()
      }
      appContext.currentActivity ?: throw NoActivityException()
      wantsReading = true
      enableReader()
    }.runOnQueue(Queues.MAIN)

    Function("stopReading") {
      wantsReading = false
      runOnUi { disableReader() }
    }

    Function("openNfcSettings") {
      openNfcSettings()
    }
  }

  // --- Capacidades -------------------------------------------------------------------------------

  private fun capabilities(): Map<String, Boolean> {
    val adapter = adapter
    val canEmit = adapter != null &&
      context?.packageManager?.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION) == true
    return mapOf(
      "supported" to (adapter != null),
      "enabled" to (adapter?.isEnabled == true),
      "canEmit" to canEmit,
      "canRead" to (adapter != null)
    )
  }

  // --- Emissão (HCE) -----------------------------------------------------------------------------

  private fun clearPayload() {
    SussurroNfcPayload.clear()
    updatePreferredService(false)
  }

  /**
   * Com a tela Conectar emitindo, o serviço do Sussurro tem a preferência sobre outro app que
   * registre o mesmo AID NDEF (sem isso, o sistema pode mostrar um seletor ou escolher o outro).
   */
  private fun updatePreferredService(preferred: Boolean) {
    val activity = appContext.currentActivity ?: return
    val adapter = adapter ?: return
    runOnUi {
      try {
        val cardEmulation = CardEmulation.getInstance(adapter)
        if (preferred) {
          cardEmulation.setPreferredService(
            activity,
            ComponentName(activity, SussurroNdefService::class.java)
          )
        } else {
          cardEmulation.unsetPreferredService(activity)
        }
      } catch (e: Exception) {
        // Sem HCE, Activity fora do primeiro plano ou NFC desligado: o serviço continua registrado.
        Log.w(TAG, "Não foi possível ajustar o serviço preferido de NFC", e)
      }
    }
  }

  // --- Leitura (reader mode) ---------------------------------------------------------------------

  /** Liga o reader mode na Activity atual. Precisa rodar na thread principal. */
  private fun enableReader() {
    val activity = appContext.currentActivity ?: return
    val adapter = adapter ?: return
    if (!adapter.isEnabled) {
      return
    }
    val previous = readerActivity
    if (previous != null && previous !== activity) {
      disableReaderOn(previous, adapter)
    }
    val extras = Bundle().apply {
      putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, PRESENCE_CHECK_DELAY_MS)
    }
    try {
      adapter.enableReaderMode(activity, { tag -> onTag(tag) }, READER_FLAGS, extras)
      readerActivity = activity
    } catch (e: Exception) {
      Log.w(TAG, "Não foi possível ligar a leitura de NFC", e)
      readerActivity = null
      sendEvent(READ_ERROR_EVENT, mapOf("code" to "disabled"))
    }
  }

  private fun disableReader() {
    val activity = readerActivity ?: return
    readerActivity = null
    lastUri = null
    val adapter = adapter ?: return
    disableReaderOn(activity, adapter)
  }

  private fun disableReaderOn(activity: Activity, adapter: NfcAdapter) {
    try {
      adapter.disableReaderMode(activity)
    } catch (e: Exception) {
      Log.w(TAG, "Não foi possível desligar a leitura de NFC", e)
    }
  }

  /** Chamado pelo sistema numa thread de binder: a leitura bloqueante fica aqui. */
  private fun onTag(tag: Tag) {
    if (!wantsReading) {
      return
    }
    val uri = try {
      readSussurroUri(tag)
    } catch (e: IOException) {
      // A tag saiu do campo no meio (o encosto foi curto demais).
      Log.d(TAG, "Leitura de NFC interrompida", e)
      sendEvent(READ_ERROR_EVENT, mapOf("code" to "read_failed"))
      return
    } catch (e: FormatException) {
      sendEvent(READ_ERROR_EVENT, mapOf("code" to "read_failed"))
      return
    } catch (e: Exception) {
      Log.w(TAG, "Falha inesperada ao ler NFC", e)
      sendEvent(READ_ERROR_EVENT, mapOf("code" to "read_failed"))
      return
    }
    if (uri == null) {
      // Uma tag ou um cartão que não tem um código do Sussurro.
      sendEvent(READ_ERROR_EVENT, mapOf("code" to "read_failed"))
      return
    }
    synchronized(this) {
      val now = SystemClock.elapsedRealtime()
      if (uri == lastUri && now - lastUriAt < DEDUPE_MS) {
        return
      }
      lastUri = uri
      lastUriAt = now
    }
    sendEvent(READ_EVENT, mapOf("uri" to uri))
  }

  /** O 1º registro URI no formato exato do Sussurro: pela pilha NDEF do sistema e, se faltar, por IsoDep. */
  private fun readSussurroUri(tag: Tag): String? {
    val ndef = Ndef.get(tag)
    if (ndef != null) {
      val message = ndef.cachedNdefMessage ?: readNdef(ndef)
      SussurroNdef.sussurroUri(message)?.let { return it }
    }
    val isoDep = IsoDep.get(tag) ?: return null
    return readIsoDep(isoDep)
  }

  private fun readNdef(ndef: Ndef): NdefMessage? =
    try {
      ndef.connect()
      ndef.ndefMessage
    } finally {
      closeQuietly { ndef.close() }
    }

  /**
   * O mesmo diálogo de um leitor Type 4 (`SussurroNdef.readType4NdefFile`, testado contra o
   * `SussurroNdefService` na JVM). Um aparelho do outro lado que responda devagar ou em pedaços
   * mínimos não prende a leitura: no máximo [ISO_DEP_MAX_APDUS] APDUs em [ISO_DEP_TOTAL_MS].
   */
  private fun readIsoDep(isoDep: IsoDep): String? {
    val deadline = SystemClock.elapsedRealtime() + ISO_DEP_TOTAL_MS
    var apdus = 0
    try {
      isoDep.connect()
      isoDep.timeout = ISO_DEP_TIMEOUT_MS
      val maxChunk = minOf(SussurroNdef.MAX_READ_LENGTH, isoDep.maxTransceiveLength - 2)
      val body = SussurroNdef.readType4NdefFile(maxChunk, MAX_NDEF_READ) { command ->
        if (apdus >= ISO_DEP_MAX_APDUS || SystemClock.elapsedRealtime() >= deadline) {
          null
        } else {
          apdus += 1
          isoDep.transceive(command)
        }
      } ?: return null
      return SussurroNdef.sussurroUriFromMessage(body)
    } finally {
      closeQuietly { isoDep.close() }
    }
  }

  private inline fun closeQuietly(block: () -> Unit) {
    try {
      block()
    } catch (e: IOException) {
      Log.d(TAG, "Falha ao fechar a tag", e)
    }
  }

  // --- Ajustes e estado do NFC -------------------------------------------------------------------

  /** "Ligar NFC": os Ajustes do NFC (ou os de conexões, se o aparelho não tiver a tela própria). */
  private fun openNfcSettings() {
    val activity = appContext.currentActivity
    val launcher: Context = activity ?: context ?: return
    for (action in listOf(Settings.ACTION_NFC_SETTINGS, Settings.ACTION_WIRELESS_SETTINGS)) {
      val intent = Intent(action)
      if (activity == null) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      try {
        launcher.startActivity(intent)
        return
      } catch (e: Exception) {
        Log.w(TAG, "Não foi possível abrir $action", e)
      }
    }
  }

  /** Avisa o JS quando o NFC liga ou desliga, e religa a leitura se ela estava pedida. */
  private fun registerStateReceiver() {
    val context = context ?: return
    if (stateReceiver != null) {
      return
    }
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        if (intent?.action != NfcAdapter.ACTION_ADAPTER_STATE_CHANGED) {
          return
        }
        val enabled = when (intent.getIntExtra(NfcAdapter.EXTRA_ADAPTER_STATE, NfcAdapter.STATE_OFF)) {
          NfcAdapter.STATE_ON -> true
          NfcAdapter.STATE_OFF -> false
          else -> return
        }
        sendEvent(STATE_EVENT, mapOf("enabled" to enabled))
        if (!wantsReading) {
          return
        }
        if (enabled) {
          runOnUi { enableReader() }
        } else {
          // O sistema já parou o reader mode; ele volta quando o NFC ligar de novo.
          readerActivity = null
          sendEvent(READ_ERROR_EVENT, mapOf("code" to "disabled"))
        }
      }
    }
    val filter = IntentFilter(NfcAdapter.ACTION_ADAPTER_STATE_CHANGED)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        context.registerReceiver(receiver, filter)
      }
      stateReceiver = receiver
    } catch (e: Exception) {
      Log.w(TAG, "Não foi possível acompanhar o estado do NFC", e)
    }
  }

  private fun unregisterStateReceiver() {
    val receiver = stateReceiver ?: return
    stateReceiver = null
    try {
      context?.unregisterReceiver(receiver)
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "Receiver do NFC já removido", e)
    }
  }

  private fun runOnUi(block: () -> Unit) {
    val activity = appContext.currentActivity
    if (activity != null) {
      activity.runOnUiThread(block)
    } else {
      block()
    }
  }
}
