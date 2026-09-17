/* ============================================================
   RETA FOOD SERVICE — Site-wide Cart Script  (v1)
   ------------------------------------------------------------
   Custom cart kept in localStorage. A line is one product plus
   one fulfilment method, so the same product can be in the cart
   twice (Delivery and Collection) at different prices.

   Phase 3: cart store + price check. Phase 4: product page
   fulfilment selector. Phase 5: cart drawer and nav badge.
   Phase 6 swaps the checkout's readCart() to this store.

   The drawer renders into Webflow's own cart markup (one row is
   cloned per line), so the design stays in the Designer. Webflow
   still opens and closes it.

   Product template hooks (set in the Designer; keep them when
   restyling, the classes around them can change freely):
     [data-reta-product]           hidden block whose children hold
                                   CMS fields as bound text:
                                   data-price-delivery, data-price-collection,
                                   data-vat-rate, data-product-name,
                                   data-product-slug, data-product-size
     [data-reta-fulfilment-group]  wraps the two price cards (display)
     [data-reta-fulfilment]        "collection" / "delivery" on each card
     [data-reta-fulfilment-select] the dropdown that chooses; its options
                                   are filled in from the prices
     [data-reta-fulfilment-row]    holds the dropdown (and the prompt)
     [data-reta-qty-down/-up]      quantity stepper buttons
     [data-reta-product-image]     main product image
   Webflow's add-to-cart form supplies the product id and quantity.

   window.RETA.cart
     get()                       -> { lines, count, subtotal }
     add(product, shipping, qty) -> line, or null if rejected
       product: { productId, slug, name, imgSrc, imgAlt, size,
                  vatRate, priceDelivery, priceCollection }
       (productId, slug, vatRate and the chosen price are required)
     setQty(key, qty)            qty below 1 removes the line
     remove(key), clear()
     subscribe(fn)               -> unsubscribe
       fn({ type, lines, count, subtotal, ... }) on every change
   window.RETA.priceCheck
     run()                       -> Promise { ok, changed, gone }
                                 gone = products whose page 404s
     on                          "open" | "checkout"

   Paste into: Site settings > Custom code > Footer code
   ============================================================ */

(function () {
  "use strict";

  // ---- DEBUG ------------------------------------------------------
  // Set DEBUG = true to print [RETA] diagnostics to the console.
  var DEBUG = false;
  function log()  { if (DEBUG) console.log.apply(console, arguments); }
  function err()  { if (DEBUG) console.error.apply(console, arguments); }

  // ---- CONFIG ----------------------------------------------------
  var STORAGE_KEY = "reta-cart-v1";
  var EXPIRY_DAYS = 7;       // cart is discarded this long after its last change
  var MAX_QTY     = 9999;

  var VARIANT_DELIVERY   = "Delivery";
  var VARIANT_COLLECTION = "Collection (Blackburn Branch)";

  // Minimum spend on the DELIVERY portion only, ex VAT. The drawer's checkout
  // button and the checkout both use this one number: the checkout reads it
  // from RETA.cart, so change it here.
  var DELIVERY_MINIMUM = 300.00;

  // Webflow's native Add to Cart threw the drawer open on every add. That gets
  // in the way when someone is adding several things, so the confirmation is
  // the button's "Added to cart" and the badge instead. Set true to bring the
  // old behaviour back.
  var OPEN_CART_ON_ADD = false;

  // Price check: re-reads prices from each product's own page.
  var PRICE_CHECK_ON         = "open";  // "open" = drawer opens, "checkout" = checkout page
  var PRICE_CHECK_TIMEOUT_MS = 2500;    // pages not back by then keep stored prices
  var PRICE_CACHE_MINUTES    = 5;       // reopening within this doesn't refetch
  var PRICE_CACHE_KEY        = "reta-prices-v1";

  // ---- HELPERS ---------------------------------------------------
  function str(v) {
    if (typeof v === "number") return String(v);
    return typeof v === "string" ? v.trim() : "";
  }
  // Strips the same characters as the checkout's parseMoney
  // ("£ 1,668.00" -> 1668), but a blank, zero or unreadable price is NaN.
  function toPrice(v) {
    var n = parseFloat(str(v).replace(/[\u00a3,\s\u00a0]/g, ""));
    return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : NaN;
  }
  function toRate(v) {
    var n = parseFloat(str(v).replace(/[^0-9.]/g, ""));
    return isFinite(n) && n <= 100 ? n : NaN;
  }
  function toQty(v) {
    var n = Math.floor(Number(v));
    return n >= 1 ? Math.min(n, MAX_QTY) : 0;
  }
  function toShipping(v) {
    v = str(v).toLowerCase();
    if (v === "delivery") return VARIANT_DELIVERY;
    if (v === "collection" || v === VARIANT_COLLECTION.toLowerCase()) return VARIANT_COLLECTION;
    return "";
  }
  function toTime(v, fallback) {
    v = Number(v);
    return isFinite(v) && v > 0 ? v : fallback;
  }
  // Same format as the checkout: "£ 1,668.00".
  function formatMoney(n) {
    return "\u00a3 " + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // A valid line, or null. Runs on new lines and on every line read back
  // from storage, so a bad blob never reaches the page.
  function cleanLine(l, t) {
    if (!l || typeof l !== "object") return null;
    var id = str(l.productId), slug = str(l.slug), shipping = toShipping(l.shipping),
        price = toPrice(l.unitPrice), rate = toRate(l.vatRate), qty = toQty(l.qty);
    if (!id || !slug || !shipping || isNaN(price) || isNaN(rate) || !qty) return null;
    return {
      key: id + "|" + shipping, productId: id, slug: slug, name: str(l.name),
      imgSrc: str(l.imgSrc), imgAlt: str(l.imgAlt), size: str(l.size),
      shipping: shipping, unitPrice: price, vatRate: rate, qty: qty,
      addedAt: toTime(l.addedAt, t), updatedAt: toTime(l.updatedAt, t)
    };
  }

  // ---- STORAGE ---------------------------------------------------
  // If localStorage is blocked or full, the cart lives in memory for the
  // rest of the page view instead of throwing.
  var memoryOnly = false, memory = null;

  function readRaw() {
    if (!memoryOnly) {
      try { return window.localStorage.getItem(STORAGE_KEY); }
      catch (e) { memoryOnly = true; err("[RETA] localStorage unavailable, cart kept in memory", e); }
    }
    return memory;
  }
  function writeRaw(s) {
    memory = s;
    if (memoryOnly) return;
    try {
      if (s === null) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, s);
    } catch (e) { memoryOnly = true; err("[RETA] cart save failed, cart kept in memory", e); }
  }

  // Unreadable or expired carts are discarded silently.
  function load() {
    var raw = readRaw(), data = null, t = Date.now();
    if (!raw) return { updatedAt: 0, lines: [] };
    try { data = JSON.parse(raw); } catch (e) {}
    var updatedAt = data ? toTime(data.updatedAt, 0) : 0;
    if (!updatedAt || !Array.isArray(data.lines)) {
      err("[RETA] cart data unreadable, starting fresh");
      writeRaw(null);
      return { updatedAt: 0, lines: [] };
    }
    if (t - updatedAt > EXPIRY_DAYS * 864e5) {
      log("[RETA] cart expired, starting fresh");
      writeRaw(null);
      return { updatedAt: 0, lines: [] };
    }
    var lines = [], byKey = {};
    data.lines.forEach(function (l) {
      l = cleanLine(l, updatedAt);
      if (!l) return;
      if (byKey[l.key]) byKey[l.key].qty = toQty(byKey[l.key].qty + l.qty);
      else { byKey[l.key] = l; lines.push(l); }
    });
    return { updatedAt: Math.min(updatedAt, t), lines: lines };
  }

  function save(cart) {
    writeRaw(cart.lines.length ? JSON.stringify({ updatedAt: cart.updatedAt, lines: cart.lines }) : null);
  }

  function snapshot(cart) {
    var count = 0, subtotal = 0, vat = 0, delivery = 0, hasDelivery = false;
    cart.lines.forEach(function (l) {
      l.lineTotal = Math.round(l.unitPrice * l.qty * 100) / 100;
      count += l.qty;
      subtotal += l.lineTotal;
      vat += l.lineTotal * (l.vatRate / 100);   // per line, like the checkout
      if (l.shipping === VARIANT_DELIVERY) { delivery += l.lineTotal; hasDelivery = true; }
    });
    // No shipping figure here: every shipping method RETA offers is free, so
    // this total matches the checkout's. A paid method would have to be added
    // in both places.
    return { lines: cart.lines, count: count,
             subtotal: Math.round(subtotal * 100) / 100,
             vatTotal: Math.round(vat * 100) / 100,
             total: Math.round((subtotal + vat) * 100) / 100,
             deliverySubtotal: Math.round(delivery * 100) / 100,
             hasDelivery: hasDelivery };
  }

  // ---- EVENTS ----------------------------------------------------
  // Types: add, qty, remove, clear, sync (another tab), checking, checked.
  var subscribers = [];

  function emit(type, extra) {
    var detail = snapshot(load());
    detail.type = type;
    for (var k in extra) detail[k] = extra[k];
    subscribers.slice().forEach(function (fn) {
      try { fn(detail); } catch (e) { err("[RETA] cart subscriber failed", e); }
    });
  }

  // ---- CART ------------------------------------------------------
  function findLine(cart, key) {
    for (var i = 0; i < cart.lines.length; i++) if (cart.lines[i].key === key) return i;
    return -1;
  }

  function add(product, shipping, qty) {
    var p = product || {}, s = toShipping(shipping), t = Date.now();
    var line = cleanLine({
      productId: p.productId, slug: p.slug, name: p.name, imgSrc: p.imgSrc,
      imgAlt: p.imgAlt, size: p.size, vatRate: p.vatRate, shipping: s,
      unitPrice: s === VARIANT_DELIVERY ? p.priceDelivery : p.priceCollection,
      qty: qty === undefined ? 1 : qty, addedAt: t, updatedAt: t
    }, t);
    if (!line) { err("[RETA] cart.add rejected:", product, shipping, qty); return null; }

    var cart = load(), i = findLine(cart, line.key);
    if (i > -1) {
      // Same product and fulfilment: add to the quantity, refresh the snapshot.
      line.qty = toQty(cart.lines[i].qty + line.qty);
      line.addedAt = cart.lines[i].addedAt;
      cart.lines[i] = line;
    } else {
      cart.lines.push(line);
    }
    cart.updatedAt = t;
    save(cart);
    emit("add", { key: line.key });
    return line;
  }

  function setQty(key, qty) {
    var n = Math.floor(Number(qty));
    if (isNaN(n)) return false;
    if (n < 1) return remove(key);
    var cart = load(), i = findLine(cart, key);
    if (i < 0) return false;
    n = Math.min(n, MAX_QTY);
    if (cart.lines[i].qty !== n) {
      cart.lines[i].qty = n;
      cart.updatedAt = cart.lines[i].updatedAt = Date.now();
      save(cart);
      emit("qty", { key: key });
    }
    return true;
  }

  function remove(key) {
    var cart = load(), i = findLine(cart, key);
    if (i < 0) return false;
    cart.lines.splice(i, 1);
    cart.updatedAt = Date.now();
    save(cart);
    emit("remove", { key: key });
    return true;
  }

  function clear() {
    writeRaw(null);
    emit("clear");
  }

  // ---- PRODUCT DATA ----------------------------------------------
  // Reads the hidden [data-reta-product] block on a product page (this page
  // or a fetched one), e.g. <div data-price-delivery>13.00</div>. Anything
  // inside a collection list (.w-dyn-item, e.g. related products) is ignored.
  // Returns the product shape cart.add() takes, or null.
  function readProductData(doc) {
    function own(sel) {
      return [].filter.call(doc.querySelectorAll(sel), function (el) { return !el.closest(".w-dyn-item"); })[0];
    }
    var box = own("[data-reta-product]"), form = own("[data-commerce-product-id]"), img = own("[data-reta-product-image]");
    if (!box) return null;
    function field(name) {
      var el = box.querySelector("[data-" + name + "]");
      return el ? el.textContent : "";
    }
    return {
      productId: form ? form.getAttribute("data-commerce-product-id") : "",
      slug: field("product-slug"), name: field("product-name"), size: field("product-size"),
      imgSrc: img ? img.getAttribute("src") : "", imgAlt: field("product-name"),
      vatRate: field("vat-rate"), priceDelivery: field("price-delivery"), priceCollection: field("price-collection")
    };
  }

  // ---- PRICE CHECK -----------------------------------------------
  // Re-reads both prices from each product's own page, /product/{slug}:
  // same-origin, no API, no token. Swappable: the store doesn't know when
  // this runs. The drawer calls RETA.priceCheck.run() on open while
  // PRICE_CHECK_ON is "open"; the checkout calls it when it's "checkout".
  // A failed, slow or unreadable page keeps the stored price.
  var checking = null;

  // sessionStorage: { productId: { delivery, collection, at } }
  function readCache() {
    try {
      var c = JSON.parse(window.sessionStorage.getItem(PRICE_CACHE_KEY));
      return c && typeof c === "object" ? c : {};
    } catch (e) { return {}; }
  }
  function isFresh(entry, t) {
    return !!entry && t - entry.at < PRICE_CACHE_MINUTES * 6e4;
  }
  function cachePrices(prices) {
    var c = readCache(), t = Date.now(), id;
    for (id in c) if (!isFresh(c[id], t)) delete c[id];
    for (id in prices) c[id] = { delivery: prices[id].delivery, collection: prices[id].collection, at: t };
    try { window.sessionStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(c)); } catch (e) {}
  }

  // The fetched page's own [data-reta-product] block, never the visible prices.
  function parseProductPage(html, productId) {
    var p = readProductData(new DOMParser().parseFromString(html, "text/html"));
    if (!p) throw new Error("no product data block");
    if (p.productId && p.productId !== productId) throw new Error("page is for another product");
    var prices = { delivery: toPrice(p.priceDelivery), collection: toPrice(p.priceCollection) };
    if (isNaN(prices.delivery) && isNaN(prices.collection)) throw new Error("no readable prices");
    return prices;
  }

  // All pages in parallel under one shared deadline. Pages back in time are
  // used; the rest keep their stored prices.
  function fetchPages(lines) {
    var ctrl = window.AbortController ? new AbortController() : null, timer, prices = {}, failed = 0, gone = [];
    var deadline = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error("timed out after " + PRICE_CHECK_TIMEOUT_MS + "ms"));
      }, PRICE_CHECK_TIMEOUT_MS);
    });
    return Promise.all(lines.map(function (l) {
      var page = fetch("/product/" + encodeURIComponent(l.slug), {
        cache: "no-cache", signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        if (!res.ok) {
          // 404/410 means the product page itself is gone: deleted, or
          // unpublished. The checkout blocks those lines.
          if (res.status === 404 || res.status === 410) gone.push(l.productId);
          throw new Error("HTTP " + res.status);
        }
        return res.text();
      }).then(function (html) {
        return parseProductPage(html, l.productId);
      });
      return Promise.race([page, deadline]).then(function (p) {
        prices[l.productId] = p;
      }, function (e) {
        failed++;
        err("[RETA] price check failed for /product/" + l.slug + ", keeping stored price:", e);
      });
    })).then(function () {
      clearTimeout(timer);
      return { prices: prices, failed: failed, gone: gone };
    });
  }

  // Applied to the cart as it is now, so edits made while pages were loading
  // are kept. Doesn't touch the cart's updatedAt: a price change doesn't
  // extend expiry.
  function applyPrices(prices) {
    var changed = [], cart = load(), t = Date.now();
    cart.lines.forEach(function (l) {
      var p = prices[l.productId];
      var price = p ? toPrice(l.shipping === VARIANT_DELIVERY ? p.delivery : p.collection) : NaN;
      if (isNaN(price) || price === l.unitPrice) return;
      changed.push({ key: l.key, name: l.name, shipping: l.shipping, from: l.unitPrice, to: price });
      l.unitPrice = price;
      l.updatedAt = t;
    });
    if (changed.length) save(cart);
    return changed;
  }

  function runPriceCheck() {
    if (checking) return checking;
    var lines = load().lines;
    if (!lines.length) return Promise.resolve({ ok: false, skipped: true, changed: [], gone: [] });

    var cache = readCache(), t = Date.now(), prices = Object.create(null), toFetch = [];
    lines.forEach(function (l) {
      if (l.productId in prices) return;
      if (isFresh(cache[l.productId], t)) prices[l.productId] = cache[l.productId];
      else { prices[l.productId] = null; toFetch.push(l); }
    });

    if (toFetch.length) emit("checking");
    checking = Promise.resolve(toFetch).then(function (list) {
      return list.length ? fetchPages(list) : { prices: {}, failed: 0, gone: [] };
    }).then(function (fetched) {
      cachePrices(fetched.prices);
      for (var id in fetched.prices) prices[id] = fetched.prices[id];
      return { ok: !fetched.failed, changed: applyPrices(prices), gone: fetched.gone };
    }).catch(function (e) {
      err("[RETA] price check failed, keeping stored prices:", e);
      return { ok: false, changed: [], gone: [] };
    }).then(function (result) {
      checking = null;
      emit("checked", result);
      return result;
    });
    return checking;
  }

  // ---- PRODUCT PAGE ----------------------------------------------
  // The dropdown chooses Collection or Delivery (the price cards stay as the
  // price display), the stepper sets the quantity, and Add to Cart writes a
  // line to this store - webflow.js's own add-to-cart never runs. A page
  // without the dropdown falls back to the cards doing the choosing.
  var SELECTOR_CSS =
    "[data-reta-fulfilment-select]{-webkit-appearance:none;-moz-appearance:none;appearance:none;cursor:pointer}" +
    "[data-reta-fulfilment-select][data-reta-needs-choice]{box-shadow:0 0 0 2px var(--reta-orange,#ee7a30)}" +
    // .body-text is sized in vw, which leaves this at about 10px on a phone,
    // so the message sets its own size. The margins matter at landscape phone
    // sizes, where the grid's 1.5vh row gap is only a few pixels.
    "[data-reta-choice-message]{color:var(--reta-orange,#ee7a30);font-weight:700;" +
      "font-size:max(13px,.9vw);line-height:1.3;margin:0;width:100%;text-align:left}" +
    "@media (max-width:991px){[data-reta-choice-message]{font-size:15px;margin:4px 0}}" +
    "@media (max-width:767px){[data-reta-choice-message]{font-size:16px;margin:8px 0 6px}}" +
    "@media (max-width:479px){[data-reta-choice-message]{font-size:15px;text-align:center;margin:4px 0 2px}}" +
    "[data-reta-qty-down],[data-reta-qty-up]{-webkit-user-select:none}" +
    "[data-reta-qty-down]:hover,[data-reta-qty-up]:hover{background:var(--light-grey,#f1f1f1)}" +
    "input[name='commerce-add-to-cart-quantity-input']{-moz-appearance:textfield;appearance:textfield}" +
    "input[name='commerce-add-to-cart-quantity-input']::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}" +
    "[data-reta-cards-select] [data-reta-fulfilment]{cursor:pointer;transition:opacity .2s}" +
    "[data-reta-cards-select][data-reta-selected] [aria-checked=false]{opacity:.55}" +
    "[data-reta-fulfilment][aria-disabled=true]{opacity:.35}";

  function initProductPage() {
    var group = document.querySelector("[data-reta-fulfilment-group]"),
        form = document.querySelector("form[data-node-type='commerce-add-to-cart-form']"),
        product = readProductData(document);
    if (!group || !form || !product) return;
    var btn = form.querySelector("[type=submit]"),
        qtyInput = form.querySelector("input[name='commerce-add-to-cart-quantity-input']"),
        select = document.querySelector("[data-reta-fulfilment-select]"),
        cards = [].slice.call(group.querySelectorAll("[data-reta-fulfilment]")),
        label = btn ? btn.value : "", chosen = "", timer, message = null;
    if (!btn || (!select && !cards.length)) return;

    var style = document.createElement("style");
    style.textContent = SELECTOR_CSS;
    document.head.appendChild(style);

    function priceOf(f) {
      return toPrice(f === "delivery" ? product.priceDelivery : product.priceCollection);
    }
    function qty() {
      return qtyInput ? toQty(qtyInput.value) || 1 : 1;
    }
    // Shown beside the dropdown only when someone tries to add without choosing.
    function say(text) {
      if (!select) return;
      if (!message) {
        message = document.createElement("div");
        message.className = "body-text";
        message.setAttribute("data-reta-choice-message", "");
        message.setAttribute("role", "alert");
        // Its own row in the buy grid, directly under the dropdown. Sharing
        // the dropdown's row squeezed the select and wrapped the text into a
        // mess at every width.
        var row = select.closest("[data-reta-fulfilment-row]");
        if (row && row.parentNode) row.parentNode.insertBefore(message, row.nextSibling);
        else (row || select.parentNode).appendChild(message);
      }
      message.textContent = text;
      message.style.display = text ? "" : "none";
    }

    // Add to Cart is never dimmed. Without a choice it asks for one instead.
    function render() {
      var price = priceOf(chosen), ready = !!chosen && !isNaN(price);
      if (select) {
        if (select.value !== chosen) select.value = chosen;
        if (chosen) {
          select.removeAttribute("data-reta-needs-choice");
          say("");
        }
      } else {
        cards.forEach(function (c) {
          c.setAttribute("aria-checked", String(c.getAttribute("data-reta-fulfilment") === chosen));
        });
        if (chosen) {
          group.setAttribute("data-reta-selected", chosen);
          group.removeAttribute("data-reta-needs-choice");
        }
      }
      btn.setAttribute("data-reta-ready", String(ready));
      btn.value = ready ? label + " – " + formatMoney(price * qty()) : label;
    }

    function askForChoice() {
      if (select) {
        select.setAttribute("data-reta-needs-choice", "");
        say("Please choose Collection or Delivery.");
        select.focus();
      } else {
        group.setAttribute("data-reta-needs-choice", "");
        var first = cards.filter(function (c) { return c.tabIndex === 0; })[0];
        if (first) first.focus();
      }
    }

    function choose(f) {
      chosen = (f === "delivery" || f === "collection") ? f : "";
      render();
    }

    if (select) {
      select.innerHTML = "";
      select.appendChild(new Option("Choose Collection or Delivery", ""));
      ["collection", "delivery"].forEach(function (f) {
        var price = priceOf(f);
        if (isNaN(price)) return;
        select.appendChild(new Option(toShipping(f) + " \u2014 " + formatMoney(price), f));
      });
      select.addEventListener("change", function () { choose(select.value); });
      cards.forEach(function (c) {   // a card with no usable price is dimmed
        if (isNaN(priceOf(c.getAttribute("data-reta-fulfilment")))) c.setAttribute("aria-disabled", "true");
      });
    } else {
      group.setAttribute("data-reta-cards-select", "");
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", "Collection or delivery");
      cards.forEach(function (c) {
        var f = c.getAttribute("data-reta-fulfilment"), price = priceOf(f);
        c.setAttribute("role", "radio");
        if ((f !== "delivery" && f !== "collection") || isNaN(price)) {
          c.setAttribute("aria-disabled", "true");
          return;
        }
        c.tabIndex = 0;
        c.setAttribute("aria-label", toShipping(f) + " " + formatMoney(price));
        c.addEventListener("click", function () { choose(f); });
        c.addEventListener("keydown", function (e) {
          if (e.key === " " || e.key === "Enter") { e.preventDefault(); choose(f); }
        });
      });
    }

    // Quantity stepper: the box stays typable, the buttons nudge it.
    function step(by) {
      if (!qtyInput) return;
      qtyInput.value = Math.min(MAX_QTY, Math.max(1, qty() + by));
      render();
    }
    [["[data-reta-qty-down]", -1], ["[data-reta-qty-up]", 1]].forEach(function (pair) {
      var el = document.querySelector(pair[0]);
      if (!el) return;
      el.addEventListener("click", function (e) { e.preventDefault(); step(pair[1]); });
      el.addEventListener("keydown", function (e) {
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); step(pair[1]); }
      });
    });
    if (qtyInput) {
      qtyInput.addEventListener("input", render);
      qtyInput.addEventListener("change", function () {
        qtyInput.value = qty();   // tidy up whatever was typed
        render();
      });
    }
    btn.setAttribute("data-reta-add-to-cart", "");

    // Take the form away from webflow.js. Its add-to-cart handlers listen on
    // window in the capture phase, so they run before any listener here could,
    // but they only act on elements marked with data-node-type.
    form.removeAttribute("data-node-type");
    btn.removeAttribute("data-node-type");

    // Every way of adding (click, Enter in the quantity box) ends in submit.
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (btn.getAttribute("data-reta-ready") !== "true") { askForChoice(); return; }
      var line = add(product, chosen, qty());
      btn.value = line ? "Added to cart" : "Sorry, this can't be added";
      clearTimeout(timer);
      timer = setTimeout(render, 2000);
      if (line && OPEN_CART_ON_ADD) openDrawer();
    });
    render();
  }

  // ---- CART DRAWER + BADGE ---------------------------------------
  // Renders the nav drawer from the store into Webflow's own cart markup, so
  // the design stays in the Designer: one existing row is cloned per line.
  // Opening and closing the drawer is still webflow.js's.
  function strip(el, names) {
    if (el) names.forEach(function (n) { el.removeAttribute(n); });
  }
  function setText(el, text) {
    if (el) el.textContent = text;
  }
  // The size line is the .cart-text that isn't the price, quantity or option
  // text - the same rule the checkout uses when it reads a cart row.
  function sizeEl(row) {
    var out = null, skip = ["price", "quantity", "spaced-right", "blue", "price-checkout"];
    [].forEach.call(row.querySelectorAll(".cart-text"), function (t) {
      if (out) return;
      for (var i = 0; i < skip.length; i++) if (t.classList.contains(skip[i])) return;
      out = t;
    });
    return out;
  }
  // A clone of the row Webflow rendered, with its bindings and cart actions
  // taken out. Falls back to Webflow's row template if the list is empty.
  function rowTemplate(list) {
    var row = list.querySelector(".w-commerce-commercecartitem");
    if (!row) {
      var id = list.getAttribute("data-wf-template-id"), tpl = id && document.getElementById(id), box;
      if (!tpl) return null;
      box = document.createElement("div");
      box.innerHTML = decodeURIComponent(tpl.textContent);
      row = box.firstElementChild;
    }
    if (!row) return null;
    row = row.cloneNode(true);
    var junk = ["data-wf-bindings", "data-wf-conditions", "data-wf-cart-action",
                "data-commerce-sku-id", "data-wf-collection", "data-wf-template-id", "id"];
    [].forEach.call(row.querySelectorAll("*"), function (el) {
      strip(el, junk);
      el.classList.remove("w-dyn-bind-empty");
      if (el.tagName === "SCRIPT") el.remove();
    });
    strip(row, junk);
    return row;
  }

  // The cart row carries Webflow's option line ("Shipping Method: Delivery").
  // It only renders while a product has options, so rebuild it if it's gone.
  function optionLine(row) {
    var info = row.querySelector(".w-commerce-commercecartiteminfo") || row,
        list = row.querySelector(".option-list, .w-commerce-commercecartoptionlist"),
        li = document.createElement("li");
    if (!list) {
      list = document.createElement("ul");
      list.className = "w-commerce-commercecartoptionlist option-list";
      info.insertBefore(list, row.querySelector(".remove-button") || null);
    }
    li.className = "option";
    li.innerHTML = '<span class="cart-text blue"></span><span class="cart-text blue">: </span>' +
                   '<span class="cart-text blue bold variant"></span>';
    list.appendChild(li);
    return li.querySelector(".variant");
  }

  function initDrawer() {
    var wrap = document.querySelector(".w-commerce-commercecartwrapper");
    if (!wrap) return;
    var badge = wrap.querySelector(".w-commerce-commercecartopenlinkcount"),
        panel = wrap.querySelector(".w-commerce-commercecartcontainerwrapper"),
        form = wrap.querySelector(".w-commerce-commercecartform"),
        list = wrap.querySelector(".w-commerce-commercecartlist"),
        empty = wrap.querySelector(".w-commerce-commercecartemptystate"),
        total = wrap.querySelector(".w-commerce-commercecartordervalue");
    if (!form || !list) return;
    var template = rowTemplate(list);
    if (!template) return;

    // Take the cart over from webflow.js: it renders this list from its own
    // (now unused) cart, which would wipe these rows.
    strip(list, ["data-wf-collection", "data-wf-template-id"]);
    strip(form, ["data-node-type"]);
    strip(badge, ["data-wf-bindings"]);
    strip(total, ["data-wf-bindings"]);
    list.innerHTML = "";
    // Webflow's error state reports on a cart nothing uses any more, and it
    // re-shows itself with an inline style that no stylesheet can beat, so it
    // goes altogether. Cart messages are the notice below.
    var errorState = wrap.querySelector(".w-commerce-commercecarterrorstate");
    if (errorState) errorState.remove();
    // Checkout Securely is webflow.js's too: it takes the click, shows its
    // data-loading-text and tries to open a Webflow order from a cart that is
    // now always empty, so the button sits on "Please wait..." and never
    // navigates. Same fix as the add-to-cart form - webflow.js matches on
    // data-node-type at click time, so removing it hands us the click.
    var checkoutBtn = wrap.querySelector(".w-commerce-commercecartcheckoutbutton");
    strip(checkoutBtn, ["data-node-type", "data-loading-text"]);

    // The drawer showed a subtotal only, so the figure on the button at the
    // checkout came as a surprise. VAT and Total are added here in the same
    // order the checkout's summary uses, cloned from Webflow's own subtotal
    // row so they take the drawer's styling.
    function summaryRow(label, after) {
      var row = after.cloneNode(true), cells = row.querySelectorAll(".cart-title, .w-commerce-commercecartordervalue");
      if (cells.length < 2) return null;
      strip(row, ["aria-atomic", "aria-live"]);
      [].forEach.call(cells, function (c) { strip(c, ["data-wf-bindings"]); });
      cells[0].textContent = label;
      cells[cells.length - 1].textContent = "";
      after.parentNode.insertBefore(row, after.nextSibling);
      return cells[cells.length - 1];
    }
    var subtotalRow = total && total.parentNode, vatValue = null, totalValue = null;
    if (subtotalRow && subtotalRow.classList.contains("w-commerce-commercecartlineitem")) {
      totalValue = summaryRow("Total", subtotalRow);
      vatValue = summaryRow("VAT", subtotalRow);
      // The checkout's summary lines sit 8px apart; Webflow's cart row adds
      // 16px on top of that. Close it up on every line but the last, whose
      // margin is the gap down to the button.
      subtotalRow.setAttribute("data-reta-tight-row", "");
      if (vatValue) vatValue.parentNode.setAttribute("data-reta-tight-row", "");
    }

    var style = document.createElement("style");
    style.textContent = "[data-reta-name-link]{color:inherit;text-decoration:none}" +
                        "[data-reta-name-link]:hover{text-decoration:underline}" +
                        "[data-reta-tight-row]{margin-bottom:0}";
    document.head.appendChild(style);

    var rows = {}, notice = null, noticeTimer, blocker = null, blocking = false,
        resyncs = 0, resyncFrom = 0;

    // The product name links back to its page.
    function nameLink(row, l) {
      var box = row.querySelector(".w-commerce-commercecartproductname");
      if (!box) return;
      var a = box.querySelector("[data-reta-name-link]");
      if (!a) {
        box.textContent = "";
        a = document.createElement("a");
        a.setAttribute("data-reta-name-link", "");
        box.appendChild(a);
      }
      a.setAttribute("href", "/product/" + encodeURIComponent(l.slug));
      a.textContent = l.name;
    }

    function fill(row, l) {
      row.setAttribute("data-reta-key", l.key);
      var img = row.querySelector("img");
      if (img) {
        img.setAttribute("src", l.imgSrc);
        img.setAttribute("alt", l.name);
        strip(img, ["srcset", "sizes"]);
      }
      nameLink(row, l);
      setText(sizeEl(row), l.size);
      setText(row.querySelector(".cart-text.price"), formatMoney(l.unitPrice));
      setText(row.querySelector(".item-vat-rate"), String(l.vatRate));
      setText(row.querySelector(".cart-quantity-div .quantity"), String(l.qty));
      setText(row.querySelector(".variant") || optionLine(row), l.shipping);
      var label = row.querySelector(".cart-text.blue:not(.variant)");
      if (label && !label.textContent.trim()) setText(label, "Shipping Method");
      var qtyInput = row.querySelector("input[name='quantity']");
      if (qtyInput && document.activeElement !== qtyInput) qtyInput.value = l.qty;
    }

    function renderDrawer(s) {
      var seen = {};
      s.lines.forEach(function (l, i) {
        var row = rows[l.key] || (rows[l.key] = template.cloneNode(true));
        fill(row, l);
        if (list.children[i] !== row) list.insertBefore(row, list.children[i] || null);
        seen[l.key] = true;
      });
      Object.keys(rows).forEach(function (k) {
        if (!seen[k]) { rows[k].remove(); delete rows[k]; }
      });
      setText(total, formatMoney(s.subtotal));
      setText(vatValue, formatMoney(s.vatTotal));
      setText(totalValue, formatMoney(s.total));
      form.style.display = s.lines.length ? "" : "none";
      if (empty) empty.style.display = s.lines.length ? "none" : "";
      if (badge) {
        badge.textContent = String(s.count);
        badge.style.display = s.count ? "" : "none";
      }
    }

    // webflow.js renders its own (unused) cart after this one and would leave
    // the empty state, subtotal and badge showing its numbers; a page restored
    // from the back/forward cache keeps whatever DOM it was frozen with. Both
    // are put back from the store.
    function domMatches(s) {
      if (list.children.length !== s.lines.length) return false;
      if (form.style.display !== (s.lines.length ? "" : "none")) return false;
      if (empty && empty.style.display !== (s.lines.length ? "none" : "")) return false;
      if (badge && (badge.textContent !== String(s.count) ||
                    badge.style.display !== (s.count ? "" : "none"))) return false;
      return true;
    }
    function resync() {
      var t = Date.now();
      if (t - resyncFrom > 2000) { resyncFrom = t; resyncs = 0; }
      if (++resyncs > 20) return;   // never spin, whatever else is writing
      var s = snapshot(load());
      if (!domMatches(s)) renderDrawer(s);
    }
    if (window.MutationObserver) {
      var pending;
      new MutationObserver(function () {
        clearTimeout(pending);
        pending = setTimeout(resync, 50);
      }).observe(wrap, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
    }
    window.addEventListener("pageshow", resync);

    // One line above the list: "Checking prices..." while the check runs, then
    // the notice if anything changed. Never blocks the cart.
    function showNotice(text, ms) {
      if (!notice) {
        notice = document.createElement("div");
        notice.className = "cart-text centered";
        notice.setAttribute("data-reta-cart-notice", "");
        list.parentNode.insertBefore(notice, list);
      }
      notice.textContent = text;
      notice.style.display = text ? "" : "none";
      notice.style.color = ms ? "var(--reta-orange, #ee7a30)" : "";
      clearTimeout(noticeTimer);
      if (text && ms) noticeTimer = setTimeout(function () { notice.style.display = "none"; }, ms);
    }

    list.addEventListener("click", function (e) {
      var btn = e.target.closest(".remove-button"), row = btn && btn.closest("[data-reta-key]");
      if (!row) return;
      e.preventDefault();
      remove(row.getAttribute("data-reta-key"));
    });
    list.addEventListener("change", function (e) {
      var input = e.target.closest("input[name='quantity']"), row = input && input.closest("[data-reta-key]");
      if (!row) return;
      // A cleared box (a number input also reports "" for anything it can't
      // read) puts the quantity back. Only a typed 0 removes the line.
      var raw = str(input.value);
      if (!raw || !setQty(row.getAttribute("data-reta-key"), raw)) renderDrawer(snapshot(load()));
    });

    // The £300 delivery minimum, worded and applied exactly as the checkout
    // does it, so the drawer never sends anyone to a checkout that refuses.
    function belowMinimum(s) {
      if (!s.hasDelivery || s.deliverySubtotal >= DELIVERY_MINIMUM) return "";
      return "Minimum order for delivery is " + formatMoney(DELIVERY_MINIMUM) +
             " (ex VAT). Your delivery items total " + formatMoney(s.deliverySubtotal) +
             ". Please add " + formatMoney(DELIVERY_MINIMUM - s.deliverySubtotal) +
             " more of delivery items, or switch them to collection.";
    }
    // Below the button that was pressed, and built from the checkout's own
    // error-box classes, so the same message reads the same in both places.
    // The list above can be scrolled away, so a message up there is no use.
    function showBlocker(text) {
      if (!blocker) {
        blocker = document.createElement("div");
        blocker.className = "checkout-validation-field-error";
        blocker.setAttribute("data-reta-cart-blocker", "");
        blocker.innerHTML = '<div class="checkout-validation-error cart" aria-live="assertive"></div>';
        checkoutBtn.parentNode.insertBefore(blocker, checkoutBtn.nextSibling);
      }
      blocker.firstChild.textContent = text;
      // That class sets display:none, so showing it needs the same priority
      // the checkout uses.
      blocker.style.setProperty("display", text ? "block" : "none", "important");
      blocking = !!text;
    }
    if (checkoutBtn) checkoutBtn.addEventListener("click", function (e) {
      e.preventDefault();
      var s = snapshot(load()), message = belowMinimum(s);
      if (!s.lines.length) return;
      if (message) { showBlocker(message); return; }
      window.location.href = checkoutBtn.getAttribute("href") || "/checkout";
    });

    subscribers.push(function (d) {
      renderDrawer(d);
      if (d.type === "checking") showNotice("Checking prices…", 0);
      else if (d.type === "checked") showNotice(d.changed && d.changed.length ? "Prices have been updated" : "", 6000);
      // The cart moved under a minimum message: recheck it rather than leave
      // a figure on screen that is no longer true.
      if (blocking) showBlocker(belowMinimum(d));
    });

    // Re-check prices whenever the drawer opens, however it was opened.
    if (window.MutationObserver && panel) {
      var open = isOpen();
      new MutationObserver(function () {
        var now = isOpen();
        if (now && !open && PRICE_CHECK_ON === "open") runPriceCheck();
        open = now;
      }).observe(panel, { attributes: true, attributeFilter: ["style", "class"] });
    }
    function isOpen() {
      return !!panel && window.getComputedStyle(panel).display !== "none";
    }

    renderDrawer(snapshot(load()));
  }

  function openDrawer() {
    var link = document.querySelector(".w-commerce-commercecartopenlink");
    if (link) link.click();
  }

  // ---- PUBLIC ----------------------------------------------------
  window.RETA = window.RETA || {};
  window.RETA.cart = {
    DELIVERY: VARIANT_DELIVERY,
    COLLECTION: VARIANT_COLLECTION,
    DELIVERY_MINIMUM: DELIVERY_MINIMUM,
    get: function () { return snapshot(load()); },
    add: add,
    setQty: setQty,
    remove: remove,
    clear: clear,
    subscribe: function (fn) {
      subscribers.push(fn);
      return function () {
        var i = subscribers.indexOf(fn);
        if (i > -1) subscribers.splice(i, 1);
      };
    }
  };
  window.RETA.priceCheck = { on: PRICE_CHECK_ON, run: runPriceCheck };

  // Another tab changed the cart: update this tab's badge and drawer too.
  window.addEventListener("storage", function (e) {
    if (e.key === STORAGE_KEY || e.key === null) emit("sync");
  });

  load();   // discards an expired or unreadable cart straight away
  // Every page load re-checks prices: the cache only saves repeat opens of the
  // drawer within one page view, so a refresh is always a way to force a check.
  try { window.sessionStorage.removeItem(PRICE_CACHE_KEY); } catch (e) {}
  try { initDrawer(); } catch (e) { err("[RETA] drawer setup failed", e); }
  try { initProductPage(); } catch (e) { err("[RETA] product page setup failed", e); }
  log("[RETA] cart script v1 ready", window.RETA.cart.get());
})();
