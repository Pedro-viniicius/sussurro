Pod::Spec.new do |s|
  s.name           = 'SussurroProximity'
  s.version        = '0.2.0'
  s.summary        = 'Leitura por NFC do código de conexão da tela Conectar do Sussurro (ADR 0013).'
  s.description    = 'Lê o registro NDEF URI sussurro://c/{token} pela folha do sistema (NFCNDEFReaderSession). Sem Bluetooth.'
  s.author         = 'Sussurro'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Weak: o app abre em aparelho sem NFC (o `readingAvailable` responde false).
  s.weak_frameworks = 'CoreNFC'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
