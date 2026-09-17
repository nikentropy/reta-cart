# RETA Food Service — cart scripts

Client-side scripts for [RETA Food Service](https://retafoodservice.co.uk), kept
here so [jsDelivr](https://www.jsdelivr.com/) can serve them. Webflow's custom
code fields are too small for them, so the site references them with a one-line
`<script src>` tag instead.

| File | Where it runs | What it does |
|---|---|---|
| `reta-cart-sitewide.js` | Site settings → Footer code, every page | Cart store (localStorage), product page Collection/Delivery selector, cart drawer and nav badge, price re-check |
| `reta-checkout.js` | Checkout page → Footer code | Renders the order from the cart, per-line VAT, shipping option, £300 delivery minimum, validation, Pay button |

They are separate files because the checkout one is only needed on `/checkout`, and a change to it shouldn't invalidate the cached site-wide file.

## Referencing a version

Pin to a commit or a tag, never to a branch, so a cached copy can't go stale:

```html
<script src="https://cdn.jsdelivr.net/gh/OWNER/REPO@COMMIT_OR_TAG/reta-cart-sitewide.js"></script>
```

- **Commit or tag:** immutable, cached forever, always the file you pinned.
- **`@main`:** convenient but cached for up to a week, so it is only used while
  developing, together with a [purge](https://www.jsdelivr.com/tools/purge).

## Updating

Pushes are made from the project's `publish_to_github.py`, which prints the new
commit-pinned URL to paste into Webflow. The site only picks up a change after
that tag is updated and the site is published.

No credentials, customer data or business data belong in this repo. Everything
here is served publicly to every visitor's browser.
