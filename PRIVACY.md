# Privacy Policy — VLESS Bridge

_Last updated: 14 July 2026_

VLESS Bridge is a browser extension that routes Chrome's traffic through a
proxy server that you provide. This policy explains what the extension does
and does not do with your data.

## Summary

VLESS Bridge does **not** collect, store, transmit, or sell any personal
data. Everything stays on your own device.

## What data the extension handles

- **Server configurations and subscription links** that you enter are stored
  locally on your device using Chrome's `storage` API. They are never sent to
  us or to any third party by the extension.
- **Proxy settings** are applied only within your Chrome browser, using
  Chrome's `proxy` API. They affect only your browser, not the rest of your
  system.

## The helper application

VLESS Bridge requires a companion helper application installed on your
computer to make the proxy connection (Chrome cannot speak the VLESS protocol
on its own). The extension communicates with this helper locally on your
device via Chrome's Native Messaging. The helper:

- fetches the subscription content from the address you provide,
- runs the local proxy connection.

All of this happens on your own machine. No data is sent to the developer.

## Data we collect

None. The developer of VLESS Bridge does not operate any server that receives
your data, does not use analytics, and does not track you.

## Third parties

The extension does not share data with third parties. When connected, your
browser traffic passes through the proxy server **you** configured; that
server is operated by you or your chosen provider, not by the developer of
this extension.

## Open source

VLESS Bridge is open source. You can review the full source code at:
https://github.com/c1goo/vless-bridge

## Contact

For questions about this policy, open an issue at:
https://github.com/c1goo/vless-bridge/issues

## Changes

If this policy changes, the updated version will be published at the same URL
with a new "Last updated" date.
