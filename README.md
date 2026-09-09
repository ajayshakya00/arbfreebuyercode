# ARB Free Buyer — Version 2.4.0

Automated order monitor and auto-buy sniper for Payjora.
Source code: [github.com/ajayshakya00/arbfreebuyercode](https://github.com/ajayshakya00/arbfreebuyercode)

## Install
1. Open Firefox -> `about:debugging` -> `This Firefox`.
2. Click **Load Temporary Add-on**.
3. Select `manifest.json`.

## Features
- **Clean UI / Zero Clutter**: No on-screen debug boxes, logs, or card outlines on the website. Everything stays native.
- **Multi-Tab Polling**: Support for all Payjora tabs:
  - `OTP-UPI (+5%)`
  - `UPI`
  - `BANK (+6%)`
  - `Quick`
  - `USDT`
- **Dynamic Action Button**: Single dynamic toggle button (switches seamlessly between Start Buying and Stop Monitoring).
- **Amount Filters**: Fixed amount or range (supports any custom number, with min < max always enforced).
- **Fast Auto-Buy**: Instant detection and clicking of the Buy button when matching orders appear.
- **Continuous Polling**: Seamlessly handles orders already taken by other users without freezing or pausing.
- **Configurable Latency**: Set custom polling latency (0 ms upwards, with indicator for recommended min 200 ms).
