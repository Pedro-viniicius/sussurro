import CoreNFC
import ExpoModulesCore

// Módulo `sussurro-proximity` (ADR 0013 §4): o código de conexão `sussurro://c/{token}` por NFC.
// O iPhone não emite (sem HCE para apps): só lê, pela folha do sistema (`NFCNDEFReaderSession`),
// que fecha sozinha depois da 1ª tag. Sem Bluetooth e sem localização.

let nfcReadEvent = "onNfcRead"
let nfcReadErrorEvent = "onNfcReadError"
let nfcStateEvent = "onNfcStateChange"

/// O app só aceita códigos com este prefixo (ADR 0013 §6, N2).
let sussurroUriPrefix = "sussurro://c/"

/// Tamanho do token do código (ADR 0013 §1).
let sussurroTokenLength = 16

/// Só `sussurro://c/` + 16 caracteres [A-Za-z0-9_-], com o tamanho exato, chega ao JS.
func isSussurroUri(_ uri: String) -> Bool {
  guard uri.utf8.count == sussurroUriPrefix.utf8.count + sussurroTokenLength,
    uri.hasPrefix(sussurroUriPrefix)
  else {
    return false
  }
  let token = uri.utf8.dropFirst(sussurroUriPrefix.utf8.count)
  return token.allSatisfy { byte in
    (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
      || (byte >= 0x30 && byte <= 0x39) || byte == 0x5F || byte == 0x2D
  }
}

internal final class NfcUnsupportedException: Exception, @unchecked Sendable {
  override var reason: String {
    "Este aparelho não lê NFC."
  }
}

public final class SussurroProximityModule: Module {
  private lazy var reader = SussurroNfcReader { [weak self] name, body in
    self?.sendEvent(name, body)
  }

  public func definition() -> ModuleDefinition {
    Name("SussurroProximity")

    Events(nfcReadEvent, nfcReadErrorEvent, nfcStateEvent)

    AsyncFunction("getNfcCapabilities") { () -> [String: Bool] in
      let supported = NFCNDEFReaderSession.readingAvailable
      return [
        "supported": supported,
        // O iOS não deixa desligar o NFC: com leitura, está sempre "ligado".
        "enabled": supported,
        // Apps de iPhone não emulam tag (sem HCE): só leem.
        "canEmit": false,
        "canRead": supported,
      ]
    }

    // Sem HCE no iPhone: existe só para a API ser a mesma do Android.
    Function("setEmittedPayload") { (_: String?) in
    }

    AsyncFunction("startReading") {
      try self.reader.start()
    }.runOnQueue(.main)

    Function("stopReading") {
      let reader = self.reader
      DispatchQueue.main.async {
        reader.stop()
      }
    }

    // O iOS não tem Ajustes de NFC.
    Function("openNfcSettings") {
    }

    OnAppEntersBackground {
      let reader = self.reader
      DispatchQueue.main.async {
        reader.stop()
      }
    }

    OnDestroy {
      let reader = self.reader
      DispatchQueue.main.async {
        reader.stop()
      }
    }
  }
}

/// A folha de leitura do sistema. Tudo roda na fila principal (`queue: .main`).
final class SussurroNfcReader: NSObject, NFCNDEFReaderSessionDelegate {
  typealias Emit = (String, [String: Any?]) -> Void

  private let emit: Emit
  private var session: NFCNDEFReaderSession?
  /// A sessão leu um código do Sussurro: o encerramento que vem depois não é erro.
  private var delivered = false

  init(emit: @escaping Emit) {
    self.emit = emit
    super.init()
  }

  func start() throws {
    guard NFCNDEFReaderSession.readingAvailable else {
      throw NfcUnsupportedException()
    }
    if session != nil {
      return
    }
    let newSession = NFCNDEFReaderSession(delegate: self, queue: .main, invalidateAfterFirstRead: true)
    newSession.alertMessage = "Aproxime o topo do iPhone das costas do outro celular."
    delivered = false
    session = newSession
    newSession.begin()
  }

  /// Fecha a folha sem emitir erro (quem pediu para parar foi o app).
  func stop() {
    guard let current = session else {
      return
    }
    session = nil
    current.invalidate()
  }

  func readerSession(_ session: NFCNDEFReaderSession, didDetectNDEFs messages: [NFCNDEFMessage]) {
    guard session === self.session else {
      return
    }
    delivered = true
    // O 1º registro URI lido; só segue se for um código do Sussurro, no formato exato.
    let uri = messages
      .flatMap { $0.records }
      .compactMap { $0.wellKnownTypeURIPayload()?.absoluteString }
      .first
    if let uri, isSussurroUri(uri) {
      emit(nfcReadEvent, ["uri": uri])
    } else {
      // Tag lida, mas sem um código do Sussurro (com `invalidateAfterFirstRead`, a folha fecha).
      emit(nfcReadErrorEvent, ["code": "read_failed"])
    }
  }

  func readerSession(_ session: NFCNDEFReaderSession, didInvalidateWithError error: Error) {
    guard session === self.session else {
      // Encerrada pelo `stop()`: o app já sabe.
      return
    }
    self.session = nil
    if delivered {
      return
    }
    emit(nfcReadErrorEvent, ["code": Self.errorCode(error)])
  }

  static func errorCode(_ error: Error) -> String {
    guard let nfcError = error as? NFCReaderError else {
      return "read_failed"
    }
    switch nfcError.code {
    case .readerSessionInvalidationErrorUserCanceled:
      return "cancelled"
    case .readerSessionInvalidationErrorSessionTimeout:
      return "timeout"
    case .readerErrorUnsupportedFeature:
      return "unsupported"
    case .readerErrorSecurityViolation, .readerSessionInvalidationErrorSystemIsBusy:
      // Sem o entitlement ou com o sistema ocupado: a leitura nem começou.
      return "disabled"
    default:
      return "read_failed"
    }
  }
}
