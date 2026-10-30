import CoreBluetooth
import ExpoModulesCore
import UIKit

// Módulo `sussurro-proximity` (ADR 0002): anuncia um único UUID de serviço de 128 bits
// (prefixo "SUSS" + 12 bytes do token efêmero) e varre os UUIDs com o mesmo prefixo. Sem nome
// local, sem conexão GATT e só com o app em primeiro plano: ao ir para o background, para tudo.
// A conversão token <-> UUID fica no TypeScript (`@sussurro/shared`), testada lá (4.3 CA6).

let sightingEvent = "onSighting"
let stateEvent = "onStateChange"
let errorEvent = "onError"

internal final class InvalidServiceUuidException: GenericException<String>, @unchecked Sendable {
  override var reason: String {
    "UUID de serviço inválido: \(param)"
  }
}

public final class SussurroProximityModule: Module {
  private lazy var radio = ProximityRadio { [weak self] name, body in
    self?.sendEvent(name, body)
  }

  public func definition() -> ModuleDefinition {
    Name("SussurroProximity")

    Events(sightingEvent, stateEvent, errorEvent)

    AsyncFunction("getCapabilitiesAsync") { (promise: Promise) in
      self.radio.capabilities(prompt: false) { result in
        promise.resolve(result)
      }
    }.runOnQueue(.main)

    AsyncFunction("requestPermissionAsync") { (promise: Promise) in
      self.radio.capabilities(prompt: true) { result in
        promise.resolve(result)
      }
    }.runOnQueue(.main)

    AsyncFunction("startAdvertisingAsync") { (serviceUuid: String) in
      try self.radio.startAdvertising(serviceUuid: serviceUuid)
    }.runOnQueue(.main)

    AsyncFunction("stopAdvertisingAsync") {
      self.radio.stopAdvertising()
    }.runOnQueue(.main)

    AsyncFunction("startScanAsync") { (prefix: String) in
      self.radio.startScan(prefix: prefix)
    }.runOnQueue(.main)

    AsyncFunction("stopScanAsync") {
      self.radio.stopScan()
    }.runOnQueue(.main)

    AsyncFunction("requestEnableBluetoothAsync") { () -> Bool in
      // O iOS não deixa o app ligar o Bluetooth: a tela oferece "Abrir Ajustes".
      return false
    }

    AsyncFunction("setKeepScreenOnAsync") { (enabled: Bool) in
      self.radio.setKeepScreenOn(enabled)
    }.runOnQueue(.main)

    // Em background o anúncio e a varredura param (PROX-28); o JS recomeça ao voltar.
    OnAppEntersBackground {
      if Thread.isMainThread {
        self.radio.stopAll()
      } else {
        DispatchQueue.main.sync {
          self.radio.stopAll()
        }
      }
    }

    OnDestroy {
      let radio = self.radio
      DispatchQueue.main.async {
        radio.stopAll()
      }
    }
  }
}

/// Estado do CoreBluetooth. Tudo roda na fila principal (os gerenciadores usam `queue: .main`).
final class ProximityRadio: NSObject, CBCentralManagerDelegate, CBPeripheralManagerDelegate {
  typealias Emit = (String, [String: Any?]) -> Void

  /// Um evento por UUID a cada meio segundo basta para a média do RSSI no JS.
  private static let sightingThrottle: TimeInterval = 0.5

  private let emit: Emit
  private var central: CBCentralManager?
  private var peripheral: CBPeripheralManager?
  private var stateWaiters: [(CBManagerState) -> Void] = []
  private var advertisedUuid: CBUUID?
  private var scanPrefix: String?
  private var lastEmission: [String: TimeInterval] = [:]

  init(emit: @escaping Emit) {
    self.emit = emit
    super.init()
  }

  // MARK: - Capacidades e permissão

  /// Sem `prompt`, nunca abre o pedido do sistema: se a permissão ainda não foi pedida, devolve
  /// "undetermined" sem criar o `CBCentralManager` (criar já dispara o pedido).
  func capabilities(prompt: Bool, completion: @escaping ([String: Any]) -> Void) {
    let authorization = CBManager.authorization
    if authorization == .notDetermined && !prompt {
      completion(Self.payload(authorization: authorization, state: nil))
      return
    }
    if authorization == .denied || authorization == .restricted {
      completion(Self.payload(authorization: authorization, state: .unauthorized))
      return
    }
    let manager = ensureCentral()
    if manager.state != .unknown && manager.state != .resetting {
      completion(Self.payload(authorization: CBManager.authorization, state: manager.state))
      return
    }
    var finished = false
    let finish: (CBManagerState?) -> Void = { state in
      if finished {
        return
      }
      finished = true
      completion(Self.payload(authorization: CBManager.authorization, state: state))
    }
    stateWaiters.append { state in
      finish(state)
    }
    // Sem resposta do sistema (pedido aberto por muito tempo): devolve o que houver.
    DispatchQueue.main.asyncAfter(deadline: .now() + (prompt ? 120 : 3)) {
      finish(nil)
    }
  }

  private static func payload(
    authorization: CBManagerAuthorization,
    state: CBManagerState?
  ) -> [String: Any] {
    let permission: String
    switch authorization {
    case .allowedAlways:
      permission = "granted"
    case .notDetermined:
      permission = "undetermined"
    default:
      permission = "denied"
    }
    let supported = state != .unsupported
    return [
      "bleSupported": supported,
      "bluetooth": state.map { Self.bluetoothName($0) } ?? "unknown",
      "permission": permission,
      "canAskAgain": authorization == .notDetermined,
      "canAdvertise": supported,
    ]
  }

  static func bluetoothName(_ state: CBManagerState) -> String {
    switch state {
    case .poweredOn:
      return "on"
    case .poweredOff:
      return "off"
    case .unauthorized:
      return "unauthorized"
    case .unsupported:
      return "unsupported"
    default:
      return "unknown"
    }
  }

  private func ensureCentral() -> CBCentralManager {
    if let central {
      return central
    }
    let manager = CBCentralManager(
      delegate: self,
      queue: .main,
      options: [CBCentralManagerOptionShowPowerAlertKey: false]
    )
    central = manager
    return manager
  }

  private func ensurePeripheral() -> CBPeripheralManager {
    if let peripheral {
      return peripheral
    }
    let manager = CBPeripheralManager(
      delegate: self,
      queue: .main,
      options: [CBPeripheralManagerOptionShowPowerAlertKey: false]
    )
    peripheral = manager
    return manager
  }

  // MARK: - Anúncio

  func startAdvertising(serviceUuid: String) throws {
    guard let uuid = UUID(uuidString: serviceUuid) else {
      throw InvalidServiceUuidException(serviceUuid)
    }
    advertisedUuid = CBUUID(nsuuid: uuid)
    let manager = ensurePeripheral()
    if manager.state == .poweredOn {
      applyAdvertisement(manager)
    }
  }

  func stopAdvertising() {
    advertisedUuid = nil
    peripheral?.stopAdvertising()
  }

  private func applyAdvertisement(_ manager: CBPeripheralManager) {
    if manager.isAdvertising {
      manager.stopAdvertising()
    }
    guard let uuid = advertisedUuid else {
      return
    }
    // Só o UUID de serviço: sem `CBAdvertisementDataLocalNameKey`, o anúncio não leva nome.
    // Nenhum serviço GATT é publicado.
    manager.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [uuid]])
  }

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    if peripheral.state == .poweredOn {
      applyAdvertisement(peripheral)
    }
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    if error != nil {
      emit(errorEvent, ["operation": "advertise", "code": "advertise_failed"])
    }
  }

  // MARK: - Varredura

  func startScan(prefix: String) {
    scanPrefix = prefix.uppercased()
    lastEmission.removeAll()
    let manager = ensureCentral()
    if manager.state == .poweredOn {
      beginScan(manager)
    }
  }

  func stopScan() {
    scanPrefix = nil
    lastEmission.removeAll()
    if let central, central.isScanning {
      central.stopScan()
    }
  }

  private func beginScan(_ manager: CBCentralManager) {
    guard scanPrefix != nil else {
      return
    }
    if manager.isScanning {
      manager.stopScan()
    }
    // Em primeiro plano, sem filtro de serviço (o prefixo é parcial): o filtro é feito abaixo.
    // Duplicados ligados para acompanhar o RSSI.
    manager.scanForPeripherals(
      withServices: nil,
      options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
    )
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    let state = central.state
    if state != .unknown && state != .resetting {
      let waiters = stateWaiters
      stateWaiters.removeAll()
      for waiter in waiters {
        waiter(state)
      }
    }
    emit(stateEvent, ["bluetooth": Self.bluetoothName(state)])
    if state == .poweredOn {
      beginScan(central)
    }
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    // Nunca conecta nem guarda o periférico: só lê os UUIDs anunciados.
    guard let prefix = scanPrefix else {
      return
    }
    let rssi = RSSI.intValue
    guard rssi < 0 else {
      return
    }
    var uuids: [CBUUID] = []
    if let list = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] {
      uuids.append(contentsOf: list)
    }
    if let list = advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID] {
      uuids.append(contentsOf: list)
    }
    let now = Date().timeIntervalSince1970
    for uuid in uuids {
      let value = uuid.uuidString
      guard value.count == 36, value.hasPrefix(prefix) else {
        continue
      }
      if let last = lastEmission[value], now - last < Self.sightingThrottle {
        continue
      }
      lastEmission[value] = now
      emit(sightingEvent, ["uuid": value, "rssi": rssi])
    }
  }

  // MARK: - Tela acesa e parada geral

  func setKeepScreenOn(_ enabled: Bool) {
    UIApplication.shared.isIdleTimerDisabled = enabled
  }

  func stopAll() {
    stopAdvertising()
    stopScan()
    UIApplication.shared.isIdleTimerDisabled = false
  }
}
