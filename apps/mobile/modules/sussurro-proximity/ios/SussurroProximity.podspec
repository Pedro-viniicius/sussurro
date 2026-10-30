Pod::Spec.new do |s|
  s.name           = 'SussurroProximity'
  s.version        = '0.1.0'
  s.summary        = 'Anúncio e varredura BLE da tela Conectar do Sussurro (ADR 0002).'
  s.description    = 'Anuncia um UUID de serviço de 128 bits (prefixo + token efêmero) e varre os UUIDs com o mesmo prefixo, sem conexão GATT.'
  s.author         = 'Sussurro'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreBluetooth'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
