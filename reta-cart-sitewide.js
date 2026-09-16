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
     [data-reta-fulfilment-group]  wraps the two price cards
     [data-reta-fulfilment]        "collection" / "delivery" on each card
     [data-reta-fulfilment-hint]   shown until a card is chosen
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
     run()                       -> Promise { ok, changed }
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
    var count = 0, subtotal = 0;
    cart.lines.forEach(function (l) {
      l.lineTotal = Math.round(l.unitPrice * l.qty * 100) / 100;
      count += l.qty;
      subtotal += l.lineTotal;
    });
    return { lines: cart.lines, count: count, subtotal: Math.round(subtotal * 100) / 100 };
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
    var ctrl = window.AbortController ? new AbortController() : null, timer, prices = {}, failed = 0;
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
        if (!res.ok) throw new Error("HTTP " + res.status);
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
      return { prices: prices, failed: failed };
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
    if (!lines.length) return Promise.resolve({ ok: false, skipped: true, changed: [] });

    var cache = readCache(), t = Date.now(), prices = Object.create(null), toFetch = [];
    lines.forEach(function (l) {
      if (l.productId in prices) return;
      if (isFresh(cache[l.productId], t)) prices[l.productId] = cache[l.productId];
      else { prices[l.productId] = null; toFetch.push(l); }
    });

    if (toFetch.length) emit("checking");
    checking = Promise.resolve(toFetch).then(function (list) {
      return list.length ? fetchPages(list) : { prices: {}, failed: 0 };
    }).then(function (fetched) {
      cachePrices(fetched.prices);
      for (var id in fetched.prices) prices[id] = fetched.prices[id];
      return { ok: !fetched.failed, changed: applyPrices(prices) };
    }).catch(function (e) {
      err("[RETA] price check failed, keeping stored prices:", e);
      return { ok: false, changed: [] };
    }).then(function (result) {
      checking = null;
      emit("checked", result);
      return result;
    });
    return checking;
  }

  // ---- PRODUCT PAGE ----------------------------------------------
  // The two price cards become a radio group with no default choice. Add to
  // Cart stays disabled until one is picked, then adds a line to this store
  // at that fulfilment's price. Webflow's native add-to-cart never runs.
  var SELECTOR_CSS =
    "[data-reta-fulfilment]{position:relative;cursor:pointer;border-radius:1vw;outline:3px solid transparent;outline-offset:.4vw;transition:opacity .2s,outline-color .2s}" +
    "[data-reta-fulfilment][aria-checked=true]{outline-color:var(--reta-dark-blue,#272252)}" +
    "[data-reta-fulfilment][aria-checked=true]::after{content:'\\2713';position:absolute;top:-.6vw;right:-.6vw;width:max(1.5vw,20px);height:max(1.5vw,20px);border-radius:50%;background:var(--reta-dark-blue,#272252);color:#fff;font:700 max(.8vw,11px)/max(1.5vw,20px) sans-serif;text-align:center}" +
    "[data-reta-selected] [aria-checked=false]{opacity:.55}" +
    "[data-reta-fulfilment]:focus-visible{outline-color:var(--reta-orange,#ee7a30)}" +
    "[data-reta-fulfilment][aria-disabled=true]{opacity:.35;cursor:not-allowed}" +
    "[data-reta-add-to-cart][aria-disabled=true]{opacity:.45;pointer-events:none}";

  function initProductPage() {
    var group = document.querySelector("[data-reta-fulfilment-group]"),
        form = document.querySelector("form[data-node-type='commerce-add-to-cart-form']"),
        product = readProductData(document);
    if (!group || !form || !product) return;
    var btn = form.querySelector("[type=submit]"),
        qtyInput = form.querySelector("input[name='commerce-add-to-cart-quantity-input']"),
        hint = document.querySelector("[data-reta-fulfilment-hint]"),
        cards = [].slice.call(group.querySelectorAll("[data-reta-fulfilment]")),
        label = btn ? btn.value : "", chosen = "", timer;
    if (!btn || !cards.length) return;

    var style = document.createElement("style");
    style.textContent = SELECTOR_CSS;
    document.head.appendChild(style);

    function priceOf(f) {
      return toPrice(f === "delivery" ? product.priceDelivery : product.priceCollection);
    }
    function qty() {
      return qtyInput ? toQty(qtyInput.value) || 1 : 1;
    }
    function render() {
      var price = priceOf(chosen), ready = !!chosen && !isNaN(price);
      cards.forEach(function (c) {
        c.setAttribute("aria-checked", String(c.getAttribute("data-reta-fulfilment") === chosen));
      });
      if (chosen) group.setAttribute("data-reta-selected", chosen);
      if (hint) hint.style.display = chosen ? "none" : "";
      btn.setAttribute("aria-disabled", String(!ready));
      btn.value = ready ? label + " \u2013 " + formatMoney(price * qty()) : label;
    }

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
      c.setAttribute("aria-label", (f === "delivery" ? "Delivery " : "Collection ") + formatMoney(price));
      c.addEventListener("click", function () { chosen = f; render(); });
      c.addEventListener("keydown", function (e) {
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); chosen = f; render(); }
      });
    });
    btn.setAttribute("data-reta-add-to-cart", "");
    if (qtyInput) qtyInput.addEventListener("input", render);

    // Take the form away from webflow.js. Its add-to-cart handlers listen on
    // window in the capture phase, so they run before any listener here could,
    // but they only act on elements marked with data-node-type.
    form.removeAttribute("data-node-type");
    btn.removeAttribute("data-node-type");

    // Every way of adding (click, Enter in the quantity box) ends in submit.
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (btn.getAttribute("aria-disabled") === "true") {
        var first = cards.filter(function (c) { return c.tabIndex === 0; })[0];
        if (first) first.focus();
        return;
      }
      var line = add(product, chosen, qty());
      btn.value = line ? "Added to cart" : "Sorry, this can't be added";
      clearTimeout(timer);
      timer = setTimeout(render, 2000);
      if (line) openDrawer();   // same as Webflow's native add-to-cart did
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

    var rows = {}, notice = null, noticeTimer;

    function fill(row, l) {
      row.setAttribute("data-reta-key", l.key);
      var img = row.querySelector("img");
      if (img) {
        img.setAttribute("src", l.imgSrc);
        img.setAttribute("alt", l.name);
        strip(img, ["srcset", "sizes"]);
      }
      setText(row.querySelector(".w-commerce-commercecartproductname"), l.name);
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
      form.style.display = s.lines.length ? "" : "none";
      if (empty) empty.style.display = s.lines.length ? "none" : "";
      if (badge) {
        badge.textContent = String(s.count);
        badge.style.display = s.count ? "" : "none";
      }
    }

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

    subscribers.push(function (d) {
      renderDrawer(d);
      if (d.type === "checking") showNotice("Checking prices…", 0);
      else if (d.type === "checked") showNotice(d.changed && d.changed.length ? "Prices have been updated" : "", 6000);
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
  try { initDrawer(); } catch (e) { err("[RETA] drawer setup failed", e); }
  try { initProductPage(); } catch (e) { err("[RETA] product page setup failed", e); }
  log("[RETA] cart script v1 ready", window.RETA.cart.get());
})();
