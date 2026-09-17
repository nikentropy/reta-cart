/* ============================================================
   RETA FOOD SERVICE — Custom Checkout Script  (v3)
   ------------------------------------------------------------
   Renders "Items in Order", computes per-line VAT + subtotal /
   VAT / total, picks the right shipping option (delivery /
   collection / mixed) from the CMS list, and enforces the £300
   delivery minimum on the delivery portion only.

   v3 (phase 6) reads the cart from window.RETA.cart, the
   site-wide cart script, instead of scraping Webflow's cart DOM.
   Everything downstream is unchanged. Also in v3:
     - prices are re-checked against the live product pages before
       an order can be placed, and a changed price asks the
       customer to look again rather than charging the new one
     - a product whose page has gone (deleted or unpublished)
       blocks checkout instead of being silently ordered
     - the double-submit guard clears on every failure path
     - the cart is cleared only from the success path, never
       before payment confirms

   Submit-to-provider is still stubbed (handleOrderSubmit) until
   the Pay by Bank provider is chosen.

   Served from GitHub + jsDelivr. The Checkout page holds only the
   one-line <script src>; this needs the site-wide cart script.
   ============================================================ */

(function () {
  "use strict";

  // ---- DEBUG ------------------------------------------------------
  // Set DEBUG = true to print [RETA] diagnostics to the console.
  // Leave false in production. Flip to true if you ever need to
  // troubleshoot the checkout after launch.
  var DEBUG = false;
  function log()  { if (DEBUG) console.log.apply(console, arguments); }
  function err()  { if (DEBUG) console.error.apply(console, arguments); }

  log("[RETA] checkout script v3 (reads the cart store) live");

  // ---- CONFIG ----------------------------------------------------
  var DELIVERY_MINIMUM = 300.00;   // £ ex-VAT minimum for delivery, and the
  // fallback only: the cart script owns this number so the drawer's checkout
  // button and this page can't disagree. Change it there.
  function deliveryMinimum() {
    var c = cartStore();
    return c && typeof c.DELIVERY_MINIMUM === "number" ? c.DELIVERY_MINIMUM : DELIVERY_MINIMUM;
  }
  var CHECK_PRICES     = true;     // re-read live prices before an order is placed
  var CONFIRM_CHANGES  = true;     // a changed price asks for one more press of Pay

  var VARIANT_DELIVERY   = "Delivery";
  var VARIANT_COLLECTION = "Collection (Blackburn Branch)";

  // ---- HELPERS ---------------------------------------------------
  function parseMoney(str) {
    if (!str) return 0;
    var n = parseFloat(str.replace(/[\u00a3,\s\u00a0]/g, ""));
    return isNaN(n) ? 0 : n;
  }
  function formatMoney(n) {
    return "\u00a3 " + formatNumber(n);
  }
  function formatNumber(n) {
    return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  // ---- READ CART -------------------------------------------------
  // The cart is the site-wide store now, not Webflow's cart DOM. Line shape
  // is what the rest of this script already expected, plus the store's own
  // key / productId / slug for the order payload.
  function cartStore() {
    return (window.RETA && window.RETA.cart) || null;
  }
  function readCart() {
    var store = cartStore();
    if (!store) {
      err("[RETA] cart script not loaded - the checkout has no cart to read.");
      return [];
    }
    return store.get().lines.map(function (l) {
      return {
        key: l.key, productId: l.productId, slug: l.slug,
        name: l.name, imgSrc: l.imgSrc, imgAlt: l.imgAlt || l.name, size: l.size,
        unitPrice: l.unitPrice, qty: l.qty, lineTotal: l.lineTotal,
        shipping: l.shipping, vatRate: l.vatRate
      };
    });
  }

  // ---- LIVE PRICES + AVAILABILITY --------------------------------
  // The cart script re-reads each product's own page. Here it is the last
  // gate before an order: a product whose page has gone can't be ordered,
  // and a price that moved is shown before anything is charged.
  var lastCheck = { gone: [], changed: [], seen: false };

  function checkPrices() {
    var pc = window.RETA && window.RETA.priceCheck;
    if (!CHECK_PRICES || !pc) return Promise.resolve(lastCheck);
    return pc.run().then(function (r) {
      lastCheck = { gone: r.gone || [], changed: r.changed || [], seen: false };
      return lastCheck;
    }, function (e) {
      err("[RETA] price check failed at checkout:", e);
      return lastCheck;
    });
  }

  // Names of cart products the check found missing, for the message.
  function unavailable(items) {
    var names = [];
    items.forEach(function (it) {
      if (lastCheck.gone.indexOf(it.productId) > -1 && names.indexOf(it.name) < 0) names.push(it.name);
    });
    return names;
  }

  // ---- RENDER ITEMS IN ORDER -------------------------------------
  // #items-in-order IS a single product row (it also carries class
  // .order-item). We treat it as the template: clone it per cart item
  // and append clones to its parent, hiding the original.
  function renderItems(items) {
    var templateRow = document.getElementById("items-in-order");
    if (!templateRow) { console.warn("[RETA] #items-in-order not found."); return; }
    var parent = templateRow.parentElement;
    if (!parent) { console.warn("[RETA] #items-in-order has no parent."); return; }

    parent.querySelectorAll("[data-reta-clone]").forEach(function (n) { n.remove(); });
    templateRow.style.display = "none";

    items.forEach(function (item) {
      var clone = templateRow.cloneNode(true);
      clone.removeAttribute("id");
      clone.setAttribute("data-reta-clone", "true");
      clone.style.display = "";

      // Image: the ID may sit on the <img> itself or a wrapper. Handle both,
      // and clear srcset (Webflow sets it and it overrides src).
      var imgHolder = clone.querySelector("#product-image-checkout");
      if (imgHolder) {
        var imgTag = (imgHolder.tagName === "IMG") ? imgHolder : imgHolder.querySelector("img");
        if (imgTag) {
          imgTag.setAttribute("src", item.imgSrc);
          imgTag.setAttribute("alt", item.imgAlt);
          imgTag.removeAttribute("srcset");
          imgTag.removeAttribute("sizes");
          imgTag.classList.remove("w-dyn-bind-empty");
        }
      }
      // Text slots: write COMPLETE strings (template now holds one element
      // per line, no separate static label fragments).
      var nm = clone.querySelector("#product-name-order"); if (nm) nm.textContent = item.name;
      var pq = clone.querySelector("#product-quantity-order"); if (pq) pq.textContent = item.size;
      var qic = clone.querySelector("#quantity-in-cart-order"); if (qic) qic.textContent = "Quantity: " + item.qty;
      var dm = clone.querySelector("#delivery-method-order"); if (dm) dm.textContent = item.shipping;
      var pr = clone.querySelector("#product-price-order"); if (pr) pr.textContent = formatMoney(item.lineTotal);
      var vr = clone.querySelector("#vat-rate-order"); if (vr) vr.textContent = "VAT Rate (" + item.vatRate + "%)";
      var va = clone.querySelector("#vat-amount-order"); if (va) va.textContent = "VAT: " + formatMoney(item.lineTotal * (item.vatRate / 100));

      // Strip duplicate inner IDs from the clone so the page stays valid.
      ["product-image-checkout","product-name-order","product-quantity-order",
       "quantity-in-cart-order","delivery-method-order","product-price-order",
       "vat-rate-order","vat-amount-order"].forEach(function (id) {
        var el = clone.querySelector("#" + id);
        if (el) el.removeAttribute("id");
      });

      parent.appendChild(clone);
    });
  }

  // ---- SHIPPING PROFILE ------------------------------------------
  function getShippingProfile(items) {
    var hasD = false, hasC = false;
    items.forEach(function (it) {
      if (it.shipping === VARIANT_DELIVERY) hasD = true;
      else if (it.shipping === VARIANT_COLLECTION) hasC = true;
    });
    if (hasD && hasC) return "mixed";
    if (hasD) return "delivery";
    if (hasC) return "collection";
    return "none";
  }

  // Map any recognised value (short keyword OR full display name) to
  // one of: "delivery" | "collection" | "mixed".
  function normaliseType(raw) {
    if (!raw) return "";
    var v = raw.trim().toLowerCase();
    // Short keywords (Option B: bound to a dedicated Type field)
    if (v === "delivery" || v === "collection" || v === "mixed") return v;
    // Full display names (Option A: bound to the Name field)
    if (v === "free delivery and collection (blackburn branch)") return "mixed";
    if (v === "free collection (blackburn branch)") return "collection";
    if (v === "free delivery") return "delivery";
    // Loose fallback: detect by keywords present in the string
    var hasDel = v.indexOf("delivery") !== -1;
    var hasCol = v.indexOf("collection") !== -1;
    if (hasDel && hasCol) return "mixed";
    if (hasDel) return "delivery";
    if (hasCol) return "collection";
    return "";
  }

  function getOptionType(optionEl) {
    // 1) Read the visible option name (most reliable on this build).
    var nameEl = optionEl.querySelector("[id='delivery-name']");
    var name = nameEl ? nameEl.textContent : "";
    var t = normaliseType(name);
    if (t) return t;
    // 2) Fallback: data-shipping-type attribute if present.
    t = normaliseType(optionEl.getAttribute("data-shipping-type"));
    if (t) return t;
    // 3) Last resort: the whole option's text content.
    return normaliseType(optionEl.textContent);
  }

  function getOptionWrappers() {
    // Each option is wrapped in a .shipping-method-container that holds BOTH
    // the name/description box and the price element. (Note: this element
    // also carries id="delivery-method-container", but the id is duplicated
    // across the 3 CMS items, so we MUST target by CLASS, not id.)
    // Anchor on each name and take its containing .shipping-method-container.
    var names = document.querySelectorAll("[id='delivery-name']");
    var wrappers = [];
    names.forEach(function (n) {
      var box = n.closest(".shipping-method-container") ||
                n.closest(".shipping-method-div") ||
                n.parentElement;
      if (box && wrappers.indexOf(box) === -1) wrappers.push(box);
    });
    return wrappers;
  }

  // OPTION A: display-only. The cart's per-item variants already decide
  // fulfilment, so we don't ask the customer to choose — we SHOW the one
  // matching option as a confirmation and hide the other two.
  function applyShippingOption(profile) {
    var options = getOptionWrappers();
    var selectedName = "", selectedAmount = 0;

    log("[RETA] applyShippingOption profile=" + profile + " | options found=" + options.length);

    options.forEach(function (opt, idx) {
      var type = "";
      try { type = getOptionType(opt); } catch (e) { err("[RETA] getOptionType threw on option", idx, e); }
      var match = (type === profile);
      log("[RETA] option " + idx + " type=" + type + " match=" + match);

      if (match) {
        opt.style.setProperty("display", "", "");   // show
        opt.removeAttribute("data-reta-hidden");
        var nameEl = opt.querySelector("[id='delivery-name']");
        if (nameEl) selectedName = nameEl.textContent.trim();
        var amtEl = opt.querySelector("[id='delivery-amount-option']") || opt.querySelector("[id='radio-delivery-amount']");
        if (amtEl) selectedAmount = parseMoney(amtEl.textContent);
      } else {
        opt.style.setProperty("display", "none", "important");  // hide, win specificity
        opt.setAttribute("data-reta-hidden", "true");
      }
    });

    return { name: selectedName, amount: selectedAmount };
  }

  // Derive a clean display name from an option's text if no name element.
  function optionDisplayName(opt) {
    var t = (opt.textContent || "").replace(/\s+/g, " ").trim();
    // Match the known names out of the blob of text.
    if (/free delivery and collection/i.test(t)) return "Free Delivery and Collection (Blackburn Branch)";
    if (/free collection/i.test(t)) return "Free Collection (Blackburn Branch)";
    if (/free delivery/i.test(t)) return "Free Delivery";
    return t;
  }

  // ---- TOTALS ----------------------------------------------------
  function calculateTotals(items, shippingAmount) {
    var subtotal = 0, vatTotal = 0, deliverySubtotal = 0;
    items.forEach(function (it) {
      subtotal += it.lineTotal;
      vatTotal += it.lineTotal * (it.vatRate / 100);
      if (it.shipping === VARIANT_DELIVERY) deliverySubtotal += it.lineTotal;
    });
    return {
      subtotal: subtotal,
      vatTotal: vatTotal,
      deliverySubtotal: deliverySubtotal,   // ex-VAT value of delivery items only
      total: subtotal + shippingAmount + vatTotal
    };
  }

  function writeSummary(totals, shipping) {
    setText("subtotal-amount", formatMoney(totals.subtotal));
    setText("vat-amount", formatMoney(totals.vatTotal));
    setText("delivery-method", shipping.name || "Select a delivery method");
    setText("delivery-amount", formatMoney(shipping.amount));
    setText("total-amount", formatMoney(totals.total));
    setButtonLabel(totals.total);   // VAT-inclusive total on the Pay button
  }

  function showEmptyCartState() {
    // Disable the Pay button and surface a clear message.
    var orderBtn = document.getElementById("order-now-button") ||
                   document.querySelector("[data-reta-order-button]");
    if (orderBtn) {
      orderBtn.setAttribute("disabled", "true");
      orderBtn.style.opacity = "0.5";
      orderBtn.style.pointerEvents = "none";
    }
    showValidationErrors(["Your cart is empty. Please add items before checking out."]);
    // Hide all shipping options when there's nothing to ship.
    getOptionWrappers().forEach(function (opt) { opt.style.display = "none"; });
  }

  // ---- DELIVERY MINIMUM ------------------------------------------
  function enforceMinimum(profile, totals) {
    var involvesDelivery = (profile === "delivery" || profile === "mixed");
    // Apply the minimum to the DELIVERY PORTION only (ex VAT), not the whole
    // basket — so a small delivery portion can't be carried by collection items.
    var deliveryValue = totals.deliverySubtotal || 0;
    var minimum = deliveryMinimum();
    var belowMin = deliveryValue < minimum;

    if (involvesDelivery && belowMin) {
      showValidationErrors([
        "Minimum order for delivery is " + formatMoney(minimum) +
        " (ex VAT). Your delivery items total " + formatMoney(deliveryValue) +
        " — please add " + formatMoney(minimum - deliveryValue) +
        " more of delivery items, or switch them to collection."
      ]);
      setOrderButtonEnabled(false);
      return false;
    }
    // Below-minimum cleared: re-enable button and clear the shared error box.
    setOrderButtonEnabled(true);
    showValidationErrors([]);
    return true;
  }

  // Find the pay button by any known selector (handles the renamed
  // .checkout-button.pay-by-bank-button as well as older ids).
  function getOrderButton() {
    return document.querySelector(".pay-by-bank-button") ||
           document.querySelector(".checkout-button.pay-by-bank-button") ||
           document.getElementById("order-now-button") ||
           document.querySelector("[data-reta-order-button]");
  }

  // Set the button's visible label to include the (VAT-inclusive) total.
  // Submit inputs show their `value`; <button>/<a> use textContent.
  function setButtonLabel(total) {
    var btn = getOrderButton();
    if (!btn) return;
    var label = "Pay by Bank \u2013 " + formatMoney(total);
    if (btn.tagName === "INPUT") {
      btn.value = label;
    } else {
      btn.textContent = label;
    }
  }

  // Centralised button enable/disable so all gates (minimum + validation)
  // agree on the button state.
  function setOrderButtonEnabled(enabled) {
    var orderBtn = getOrderButton();
    if (!orderBtn) return;
    if (enabled) {
      orderBtn.removeAttribute("disabled");
      orderBtn.style.opacity = "";
      orderBtn.style.pointerEvents = "";
    } else {
      orderBtn.setAttribute("disabled", "true");
      orderBtn.style.opacity = "0.5";
      orderBtn.style.pointerEvents = "none";
    }
  }

  // ---- FORM VALIDATION -------------------------------------------
  // Field IDs are assumed; adjust to match your form. Each entry:
  // { id, label, required, type }. Address fields only required for delivery.
  var FORM_FIELDS = [
    { id: "business-name",     label: "Business name",  required: true },
    { id: "full-name",         label: "Full name",      required: true },
    { id: "email",             label: "Email",          required: true, type: "email" },
    { id: "phone",             label: "Phone",          required: true },
    { id: "street-address-1",  label: "Street address", required: true,  deliveryOnly: true },
    { id: "street-address-2",  label: "Street address line 2", required: false, deliveryOnly: true },
    { id: "city",              label: "City / town",    required: true,  deliveryOnly: true },
    { id: "county",            label: "County",         required: false, deliveryOnly: true },
    { id: "post-code",         label: "Post code",      required: true,  deliveryOnly: true }
    // country is fixed to "United Kingdom" — no validation needed.
  ];

  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  // Returns { ok: bool, errors: [..] }. Address fields skipped for collection-only.
  function validateForm(profile) {
    var errors = [];
    var needsAddress = (profile === "delivery" || profile === "mixed");
    log("[RETA] validateForm running. profile=" + profile + " needsAddress=" + needsAddress);

    FORM_FIELDS.forEach(function (f) {
      if (f.deliveryOnly && !needsAddress) { log("[RETA]   skip (collection) " + f.id); return; }
      var el = document.getElementById(f.id);
      if (!el) { log("[RETA]   NOT FOUND " + f.id); return; }
      var tag = el.tagName;
      var val = (el.value !== undefined ? el.value : el.textContent || "").trim();
      log("[RETA]   field " + f.id + " tag=" + tag + " required=" + f.required + " value='" + val + "'");
      if (f.required && !val) {
        errors.push(f.label + " is required.");
        markField(el, false);
      } else if (f.type === "email" && val && !isValidEmail(val)) {
        errors.push("Please enter a valid email address.");
        markField(el, false);
      } else {
        markField(el, true);
      }
    });

    log("[RETA] validateForm result: ok=" + (errors.length === 0) + " errors=" + JSON.stringify(errors));
    return { ok: errors.length === 0, errors: errors };
  }

  // Visual cue on invalid fields (red border). Adjust class if you prefer.
  function markField(el, ok) {
    if (!el) return;
    if (ok) {
      el.style.borderColor = "";
      el.removeAttribute("data-reta-invalid");
    } else {
      el.style.borderColor = "#c0392b";
      el.setAttribute("data-reta-invalid", "true");
    }
  }

  function showValidationErrors(errors) {
    var wrapper = document.querySelector(".checkout-validation-field-error"); // red box (show/hide)
    var textEl  = document.querySelector(".checkout-validation-error");       // text inside it
    log("[RETA] showValidationErrors: wrapper=" + (!!wrapper) + " textEl=" + (!!textEl) + " errors=" + errors.length);
    if (errors.length) {
      // Force visible with priority in case Webflow CSS sets display:none.
      if (wrapper) wrapper.style.setProperty("display", "block", "important");
      if (textEl) textEl.textContent = errors[0];
      else if (wrapper) wrapper.textContent = errors[0];
    } else {
      if (wrapper) wrapper.style.setProperty("display", "none", "important");
      if (textEl) textEl.textContent = "";
    }
  }

  // ---- SUBMIT (STUB) ---------------------------------------------
  // The Pay by Bank provider slots in here. It gets the same state plus
  // `done`: call done(true) only when payment is CONFIRMED (that clears the
  // cart), and done(false) on failure, cancel or a closed payment window
  // (that hands the button back so the customer can try again).
  function handleOrderSubmit(state, done) {
    log("[RETA] Order submit payload:", state);
    alert("Payment integration not yet connected (provider pending procurement).");
    done(false);
  }

  // The only place the cart is ever cleared.
  function orderFinished(ok) {
    if (!ok) { releaseOrderButton(); return; }
    var store = cartStore();
    if (store) store.clear();
    log("[RETA] payment confirmed - cart cleared.");
  }

  // Lets the customer try again after anything that stopped the order.
  function releaseOrderButton() {
    var btn = getOrderButton();
    if (btn) btn.removeAttribute("data-reta-submitting");
    setOrderButtonEnabled(true);
  }

  // Non-mutating check: are all relevant required fields valid right now?
  // (Does NOT add red outlines — used for live clearing only.)
  function allRelevantFieldsValid() {
    var profile = getShippingProfile(readCart());
    var needsAddress = (profile === "delivery" || profile === "mixed");
    for (var i = 0; i < FORM_FIELDS.length; i++) {
      var f = FORM_FIELDS[i];
      if (f.deliveryOnly && !needsAddress) continue;
      var el = document.getElementById(f.id);
      if (!el) continue;
      var val = (el.value || "").trim();
      if (f.required && !val) return false;
      if (f.type === "email" && val && !isValidEmail(val)) return false;
    }
    return true;
  }

  // ---- LIVE FIELD VALIDATION -------------------------------------
  // Clear a field's error as soon as it becomes valid (on input/change),
  // rather than waiting for the next Pay-by-Bank click.
  function attachLiveValidation() {
    FORM_FIELDS.forEach(function (f) {
      var el = document.getElementById(f.id);
      if (!el || el.getAttribute("data-reta-live") === "true") return;
      el.setAttribute("data-reta-live", "true");

      var handler = function () {
        var val = (el.value || "").trim();
        var valid = true;
        if (f.required && !val) valid = false;
        else if (f.type === "email" && val && !isValidEmail(val)) valid = false;

        // Only clear THIS field's red outline when it becomes valid.
        // Don't mark it red while they're still typing in it — that's
        // handled on click. (Clearing-only avoids nagging mid-entry.)
        if (valid) markField(el, true);

        // If everything relevant is now valid, clear the shared error box —
        // but check without re-marking other fields red mid-typing.
        if (valid && allRelevantFieldsValid()) {
          showValidationErrors([]);
        }
      };

      el.addEventListener("input", handler);
      el.addEventListener("change", handler);  // covers paste / autofill
      el.addEventListener("blur", handler);
    });
  }

  // ---- MAIN ------------------------------------------------------
  function run() {
    var items = readCart();
    if (!items.length) {
      log("[RETA] No cart items found on checkout page — showing empty state.");
      showEmptyCartState();
      return;
    }
    try { renderItems(items); } catch (e) { err("[RETA] renderItems failed:", e); }
    var profile = getShippingProfile(items);
    var shipping = { name: "", amount: 0 };
    try { shipping = applyShippingOption(profile); } catch (e) { err("[RETA] applyShippingOption failed:", e); }
    var totals = calculateTotals(items, shipping.amount);
    try { writeSummary(totals, shipping); } catch (e) { err("[RETA] writeSummary failed:", e); }
    try { enforceMinimum(profile, totals); } catch (e) { err("[RETA] enforceMinimum failed:", e); }
    log("[RETA] Rendered", items.length, "items | profile:", profile, "| subtotal:", totals.subtotal);
    try { attachLiveValidation(); } catch (e) { err("[RETA] attachLiveValidation failed:", e); }

    var orderBtn = document.getElementById("order-now-button") || document.querySelector("[data-reta-order-button]");
    if (orderBtn && orderBtn.getAttribute("data-reta-bound") !== "true") {
      orderBtn.setAttribute("data-reta-bound", "true");
      orderBtn.addEventListener("click", function (e) {
        e.preventDefault();
        // Gate 0: one order at a time. Set before anything async so a second
        // click can't slip through, and cleared again by every path below
        // that doesn't end in a confirmed payment.
        if (orderBtn.getAttribute("data-reta-submitting") === "true") return;
        orderBtn.setAttribute("data-reta-submitting", "true");
        setOrderButtonEnabled(false);
        // Prices and availability are confirmed against the live product
        // pages first; a failed check leaves the stored prices in place.
        checkPrices().then(placeOrder, placeOrder);
      });

      function placeOrder() {
        // Re-read the cart at CLICK time — don't trust values captured at
        // page load, because the cart can change after the script first ran.
        var liveItems = readCart();
        var liveProfile = getShippingProfile(liveItems);
        var liveShipping = applyShippingOption(liveProfile);
        var liveTotals = calculateTotals(liveItems, liveShipping.amount);
        log("[RETA] click: profile=" + liveProfile + " items=" + liveItems.length + " deliverySub=" + liveTotals.deliverySubtotal);

        if (!liveItems.length) {
          showValidationErrors(["Your cart is empty. Please add items before checking out."]);
          releaseOrderButton();
          return;
        }
        // Gate 1: nothing in the cart has been withdrawn
        var missing = unavailable(liveItems);
        if (missing.length) {
          showValidationErrors([missing.join(", ") + (missing.length > 1 ? " are" : " is") +
            " no longer available. Please remove " + (missing.length > 1 ? "them" : "it") +
            " from your cart to continue."]);
          releaseOrderButton();
          return;
        }
        // Gate 2: a price moved since the order was reviewed — show the new
        // total and let the customer press Pay again, rather than charging it
        if (CONFIRM_CHANGES && lastCheck.changed.length && !lastCheck.seen) {
          lastCheck.seen = true;
          run();
          showValidationErrors(["Prices have been updated. Please check your order and press Pay by Bank again."]);
          releaseOrderButton();
          return;
        }
        // Gate 3: delivery minimum
        if (!enforceMinimum(liveProfile, liveTotals)) { releaseOrderButton(); return; }
        // Gate 4: required fields + email format
        var v = validateForm(liveProfile);
        if (!v.ok) { showValidationErrors(v.errors); releaseOrderButton(); return; }
        showValidationErrors([]); // clear
        handleOrderSubmit({ items: liveItems, totals: liveTotals, shipping: liveShipping, profile: liveProfile },
                          orderFinished);
      }
    }
  }

  // ---- START -----------------------------------------------------
  // No polling: the store says when the cart changes, which covers price
  // updates from the live check and edits made in the drawer or another tab.
  function start() {
    run();
    var store = cartStore();
    if (store) store.subscribe(function () { run(); });
    checkPrices().then(function () { run(); });
  }

  // The site-wide cart script normally runs first; wait briefly in case the
  // page loads them the other way round.
  function whenCartReady(fn) {
    var tries = 0;
    (function poll() {
      if (cartStore() || tries++ > 30) return fn();
      setTimeout(poll, 100);
    })();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { whenCartReady(start); });
  } else {
    whenCartReady(start);
  }
})();