iPhone Duo inner display (iOS 27.1, 951x669 pt), Settings search field focused, software keyboard docked.
Captured with the AutoMobile 0.0.94 daemon: observe {"platform":"ios","raw":true}. The file is the complete ObserveResult
the daemon wrote, byte for byte except that no host path appears in it.
UIKeyboard is [75,449,876,668] and the keycaps span 83-874, but the keyboard host view (the nearest wider ancestor of
UIKeyboard) is [0,405,951,669]: the keyboard covers the full inner width (#18248).
