package expo.modules.sussurroproximity

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import expo.modules.interfaces.permissions.PermissionsResponse
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap

// Módulo `sussurro-proximity` (ADR 0002): anuncia um único UUID de serviço de 128 bits
// (prefixo "SUSS" + 12 bytes do token efêmero) e varre os UUIDs com o mesmo prefixo. Sem nome do
// aparelho, sem conexão GATT e só com o app em primeiro plano: em background, para tudo. A
// conversão token <-> UUID fica no TypeScript (`@sussurro/shared`), testada lá (4.3 CA6).

private const val TAG = "SussurroProximity"
private const val SIGHTING_EVENT = "onSighting"
private const val STATE_EVENT = "onStateChange"
private const val ERROR_EVENT = "onError"

/** Um evento por UUID a cada meio segundo basta para a média do RSSI no JS. */
private const val SIGHTING_THROTTLE_MS = 500L

/** Máscara do `ScanFilter`: só os 4 primeiros bytes (o prefixo) precisam bater. */
private val PREFIX_MASK: ParcelUuid = ParcelUuid.fromString("ffffffff-0000-0000-0000-000000000000")

internal class BluetoothUnavailableException :
  CodedException("ERR_BLUETOOTH_UNAVAILABLE", "O Bluetooth está desligado ou indisponível.", null)

internal class AdvertisingUnsupportedException :
  CodedException("ERR_ADVERTISING_UNSUPPORTED", "Este aparelho não consegue anunciar por Bluetooth.", null)

internal class BluetoothPermissionException(cause: Throwable) :
  CodedException("ERR_BLUETOOTH_PERMISSION", "Sem permissão de Bluetooth.", cause)

internal class InvalidServiceUuidException(value: String, cause: Throwable) :
  CodedException("ERR_INVALID_SERVICE_UUID", "UUID de serviço inválido: $value", cause)

class SussurroProximityModule : Module() {
  @Volatile private var advertiseCallback: AdvertiseCallback? = null
  @Volatile private var scanCallback: ScanCallback? = null
  @Volatile private var scanPrefix: String? = null
  private var stateReceiver: BroadcastReceiver? = null
  private val lastEmission = ConcurrentHashMap<String, Long>()

  private val context: Context?
    get() = appContext.reactContext

  private val adapter: BluetoothAdapter?
    get() = (context?.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  override fun definition() = ModuleDefinition {
    Name("SussurroProximity")

    Events(SIGHTING_EVENT, STATE_EVENT, ERROR_EVENT)

    OnCreate {
      registerStateReceiver()
    }

    OnDestroy {
      stopAll()
      unregisterStateReceiver()
    }

    // Em background o anúncio e a varredura param (PROX-28); o JS recomeça ao voltar.
    OnActivityEntersBackground {
      stopAll()
    }

    AsyncFunction("getCapabilitiesAsync") { promise: Promise ->
      checkPermissions(false, promise)
    }

    AsyncFunction("requestPermissionAsync") { promise: Promise ->
      checkPermissions(true, promise)
    }

    AsyncFunction("startAdvertisingAsync") { serviceUuid: String ->
      startAdvertising(serviceUuid)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stopAdvertisingAsync") {
      stopAdvertising()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("startScanAsync") { prefix: String ->
      startScan(prefix)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stopScanAsync") {
      stopScan()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("requestEnableBluetoothAsync") {
      requestEnableBluetooth()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setKeepScreenOnAsync") { enabled: Boolean ->
      setKeepScreenOn(enabled)
    }.runOnQueue(Queues.MAIN)
  }

  // --- Permissões e capacidades ---------------------------------------------------------------

  /**
   * Android 12+: só "Dispositivos próximos" (`BLUETOOTH_SCAN` com `neverForLocation`,
   * `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`). Android ≤ 11: a localização que o sistema exige
   * para varrer (declarada com `maxSdkVersion` 30 no manifesto). 4.3 CA5.
   */
  private fun requiredPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      arrayOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_ADVERTISE,
        Manifest.permission.BLUETOOTH_CONNECT
      )
    } else {
      arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  private fun checkPermissions(ask: Boolean, promise: Promise) {
    val permissions = appContext.permissions
    if (permissions == null) {
      promise.resolve(capabilities("undetermined", true))
      return
    }
    val listener = PermissionsResponseListener { result -> promise.resolve(capabilities(result)) }
    if (ask) {
      permissions.askForPermissions(listener, *requiredPermissions())
    } else {
      permissions.getPermissions(listener, *requiredPermissions())
    }
  }

  private fun capabilities(result: Map<String, PermissionsResponse>): Map<String, Any> {
    val responses = result.values
    val permission = when {
      responses.isNotEmpty() && responses.all { it.status == PermissionsStatus.GRANTED } -> "granted"
      responses.any { it.status == PermissionsStatus.DENIED } -> "denied"
      else -> "undetermined"
    }
    return capabilities(permission, responses.all { it.canAskAgain })
  }

  private fun capabilities(permission: String, canAskAgain: Boolean): Map<String, Any> {
    val hasBle = context?.packageManager?.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) == true
    val adapter = if (hasBle) adapter else null
    val enabled = adapter?.isEnabled == true
    val bluetooth = when {
      adapter == null -> "unsupported"
      enabled -> "on"
      else -> "off"
    }
    // `isMultipleAdvertisementSupported` só é confiável com o Bluetooth ligado.
    val canAdvertise = adapter != null && (!enabled || adapter.isMultipleAdvertisementSupported)
    return mapOf(
      "bleSupported" to (adapter != null),
      "bluetooth" to bluetooth,
      "permission" to permission,
      "canAskAgain" to canAskAgain,
      "canAdvertise" to canAdvertise
    )
  }

  // --- Anúncio ----------------------------------------------------------------------------------

  @SuppressLint("MissingPermission")
  private fun startAdvertising(serviceUuid: String) {
    val adapter = adapter
    if (adapter == null || !adapter.isEnabled) {
      throw BluetoothUnavailableException()
    }
    val advertiser = adapter.bluetoothLeAdvertiser
    if (advertiser == null || !adapter.isMultipleAdvertisementSupported) {
      throw AdvertisingUnsupportedException()
    }
    val uuid = try {
      ParcelUuid.fromString(serviceUuid)
    } catch (e: IllegalArgumentException) {
      throw InvalidServiceUuidException(serviceUuid, e)
    }
    stopAdvertising()
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
      .setConnectable(false)
      .setTimeout(0)
      .build()
    // Só o UUID de serviço: sem o nome do aparelho e sem o nível de potência.
    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .addServiceUuid(uuid)
      .build()
    val callback = object : AdvertiseCallback() {
      override fun onStartFailure(errorCode: Int) {
        if (advertiseCallback === this) {
          advertiseCallback = null
        }
        sendEvent(ERROR_EVENT, mapOf("operation" to "advertise", "code" to advertiseError(errorCode)))
      }
    }
    try {
      advertiser.startAdvertising(settings, data, callback)
      advertiseCallback = callback
    } catch (e: SecurityException) {
      throw BluetoothPermissionException(e)
    }
  }

  @SuppressLint("MissingPermission")
  private fun stopAdvertising() {
    val callback = advertiseCallback ?: return
    advertiseCallback = null
    try {
      adapter?.bluetoothLeAdvertiser?.stopAdvertising(callback)
    } catch (e: Exception) {
      Log.w(TAG, "Não foi possível parar o anúncio", e)
    }
  }

  private fun advertiseError(code: Int): String = when (code) {
    AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "unsupported"
    AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "too_many_advertisers"
    AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE -> "data_too_large"
    AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED -> "already_started"
    else -> "internal_error"
  }

  // --- Varredura --------------------------------------------------------------------------------

  @SuppressLint("MissingPermission")
  private fun startScan(prefix: String) {
    val adapter = adapter
    if (adapter == null || !adapter.isEnabled) {
      throw BluetoothUnavailableException()
    }
    val scanner = adapter.bluetoothLeScanner ?: throw BluetoothUnavailableException()
    val prefixUuid = try {
      ParcelUuid.fromString("$prefix-0000-0000-0000-000000000000")
    } catch (e: IllegalArgumentException) {
      throw InvalidServiceUuidException(prefix, e)
    }
    stopScan()
    scanPrefix = prefix.lowercase()
    lastEmission.clear()
    val filter = ScanFilter.Builder().setServiceUuid(prefixUuid, PREFIX_MASK).build()
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        handleResult(result)
      }

      override fun onBatchScanResults(results: MutableList<ScanResult>) {
        results.forEach { handleResult(it) }
      }

      override fun onScanFailed(errorCode: Int) {
        if (scanCallback === this) {
          scanCallback = null
        }
        sendEvent(ERROR_EVENT, mapOf("operation" to "scan", "code" to "scan_failed_$errorCode"))
      }
    }
    try {
      scanner.startScan(listOf(filter), settings, callback)
      scanCallback = callback
    } catch (e: SecurityException) {
      throw BluetoothPermissionException(e)
    }
  }

  /** Só lê os UUIDs do anúncio: nunca conecta nem guarda o aparelho visto. */
  private fun handleResult(result: ScanResult) {
    val prefix = scanPrefix ?: return
    val uuids = result.scanRecord?.serviceUuids ?: return
    val now = SystemClock.elapsedRealtime()
    for (parcel in uuids) {
      val value = parcel.uuid.toString()
      if (!value.startsWith(prefix)) {
        continue
      }
      val last = lastEmission[value]
      if (last != null && now - last < SIGHTING_THROTTLE_MS) {
        continue
      }
      lastEmission[value] = now
      sendEvent(SIGHTING_EVENT, mapOf("uuid" to value, "rssi" to result.rssi))
    }
  }

  @SuppressLint("MissingPermission")
  private fun stopScan() {
    scanPrefix = null
    lastEmission.clear()
    val callback = scanCallback ?: return
    scanCallback = null
    try {
      adapter?.bluetoothLeScanner?.stopScan(callback)
    } catch (e: Exception) {
      Log.w(TAG, "Não foi possível parar a varredura", e)
    }
  }

  // --- Ligar o Bluetooth, tela acesa e parada geral -----------------------------------------------

  /** Pedido do sistema para ligar o Bluetooth ("Ligar Bluetooth", ux.md §4.12). */
  @SuppressLint("MissingPermission")
  private fun requestEnableBluetooth(): Boolean {
    val activity = appContext.currentActivity ?: return false
    return try {
      activity.startActivity(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE))
      true
    } catch (e: Exception) {
      Log.w(TAG, "Não foi possível pedir para ligar o Bluetooth", e)
      false
    }
  }

  private fun setKeepScreenOn(enabled: Boolean) {
    val activity = appContext.currentActivity ?: return
    activity.runOnUiThread {
      if (enabled) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
    }
  }

  private fun stopAll() {
    stopAdvertising()
    stopScan()
    setKeepScreenOn(false)
  }

  /** Avisa o JS quando o Bluetooth liga ou desliga (para sair de "O Bluetooth está desligado"). */
  private fun registerStateReceiver() {
    val context = context ?: return
    if (stateReceiver != null) {
      return
    }
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) {
          return
        }
        val value = when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
          BluetoothAdapter.STATE_ON -> "on"
          BluetoothAdapter.STATE_OFF -> "off"
          else -> return
        }
        if (value == "off") {
          // O sistema já parou o anúncio e a varredura.
          advertiseCallback = null
          scanCallback = null
        }
        sendEvent(STATE_EVENT, mapOf("bluetooth" to value))
      }
    }
    val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        context.registerReceiver(receiver, filter)
      }
      stateReceiver = receiver
    } catch (e: Exception) {
      Log.w(TAG, "Não foi possível acompanhar o estado do Bluetooth", e)
    }
  }

  private fun unregisterStateReceiver() {
    val receiver = stateReceiver ?: return
    stateReceiver = null
    try {
      context?.unregisterReceiver(receiver)
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "Receiver do Bluetooth já removido", e)
    }
  }
}
