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
- **Dynamic Action Button**: Single dynamic toggle button (switches seamlessly between Start Monitoring and Stop Monitoring).
- **Amount Filters**: Fixed amount or range (₹100 – ₹50,000).
- **Fast Auto-Buy**: Instant detection and clicking of the Buy button when matching orders appear.
- **Continuous Polling**: Seamlessly handles orders already taken by other users without freezing or pausing.
- **Configurable Latency**: Set refresh frequency down to 200 ms.
