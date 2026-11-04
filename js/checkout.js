/**
 * checkout.js - NOVARUM Commerce Engine - Gate 2-A2
 * Unified Commercial Checkout UI & Client Flow (Hardened per Codex QA)
 *
 * Controls implemented:
 * 1. Immutable purchase intent snapshot (payload + idempotency_key frozen on submit;
 *    never auto-regenerates key on HTTP 409; requires explicit user action for new intent).
 * 2. Request correlation & race condition protection (confirmation strictly bound to
 *    submitted snapshot SKU, form/selector locked during submit, late responses discarded).
 * 3. Staging safety: payment coordination button disabled by default unless explicitly
 *    enabled via feature flag; zero promises of Moodle credentials in staging.
 * 4. Explicit & validated NOVARUM_API_BASE configuration (no empty relative fallback).
 * 5. Strict 200/201 server response validation (no fake order number or NaN fallbacks).
 * 6. Accessible modal dialog: Tab/Shift+Tab focus trap, inert background, focus return
 *    to trigger button, aria-describedby / aria-invalid field bindings, aria-live regions.
 * 7. Contract-only order statuses & safe textContent DOM rendering.
 */

(function () {
  'use strict';

  // 1. Official Catalog Definitions (Frozen)
  const PRODUCTS = Object.freeze({
    'mujer-informada-4': Object.freeze({
      sku: 'mujer-informada-4',
      title: 'Pack Completo: Mujer Informada (4 Cursos)',
      tag: 'Pack Integral · 4 Cursos',
      priceFormatted: 'Bs 199',
      priceMinor: 19900,
      currency: 'BOB',
    }),
    'endometriosis': Object.freeze({
      sku: 'endometriosis',
      title: 'Curso: Endometriosis (Del Dolor a la Comprensión)',
      tag: 'Curso Individual',
      priceFormatted: 'Bs 79',
      priceMinor: 7900,
      currency: 'BOB',
    }),
    'vaginosis': Object.freeze({
      sku: 'vaginosis',
      title: 'Curso: Vaginosis Bacteriana (Reconocimiento y Cuidados)',
      tag: 'Curso Individual',
      priceFormatted: 'Bs 79',
      priceMinor: 7900,
      currency: 'BOB',
    }),
    'sop': Object.freeze({
      sku: 'sop',
      title: 'Curso: Síndrome de Ovario Poliquístico (SOP)',
      tag: 'Curso Individual',
      priceFormatted: 'Bs 79',
      priceMinor: 7900,
      currency: 'BOB',
    }),
    'aprende-mujer': Object.freeze({
      sku: 'aprende-mujer',
      title: 'Curso: Aprende Mujer (Microbiota y pH)',
      tag: 'Curso Individual',
      priceFormatted: 'Bs 79',
      priceMinor: 7900,
      currency: 'BOB',
    }),
  });

  // 2. Approved Backend Contract Statuses Only (Zero undocumented states)
  const ALLOWED_ORDER_STATUSES = Object.freeze([
    'pending_payment',
    'paid_verified',
    'enrollment_pending',
    'fulfilled',
    'cancelled',
    'expired',
  ]);

  const ORDER_STATUS_LABELS = Object.freeze({
    pending_payment: 'Pendiente de Pago (Asistido por Operador)',
    paid_verified: 'Pago Verificado en Banco',
    enrollment_pending: 'Matrícula en Trámite (Moodle)',
    fulfilled: 'Matriculado / Acceso Habilitado',
    cancelled: 'Pedido Cancelado',
    expired: 'Plazo de Pago Expirado',
  });

  // 3. Internal State
  let currentSku = 'mujer-informada-4';
  let currentIdempotencyKey = null;
  let currentIntentSnapshot = null; // Frozen payload bound to currentIdempotencyKey while pending resolution
  let currentOpaqueToken = null;
  let isSubmitting = false;
  let activeRequestId = 0;
  let activeAbortController = null;
  let lastTriggerElement = null;
  let lastPendingAlert = null;
  let pendingRequestedSku = null;
  let hasCompletedOrder = false;

  // 4. Explicit & Validated API Base Resolution (No empty/relative fallback)
  function resolveValidApiBase() {
    const raw = window.NOVARUM_API_BASE;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      if (!parsed.hostname) {
        return null;
      }
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        return null;
      }
      const cleanPath = parsed.pathname.replace(/\/+$/, '');
      return `${parsed.origin}${cleanPath}`;
    } catch (_) {
      return null;
    }
  }

  // 5. UTM Capture and Persistence
  function getSanitizedUtm() {
    const sanitizeParam = (val) => {
      if (!val || typeof val !== 'string') return null;
      const clean = val.replace(/[^a-zA-Z0-9_-]/g, '').trim().slice(0, 64);
      return clean.length > 0 ? clean : null;
    };

    const params = new URLSearchParams(window.location.search);
    const source = sanitizeParam(params.get('utm_source'));
    const medium = sanitizeParam(params.get('utm_medium'));
    const campaign = sanitizeParam(params.get('utm_campaign'));
    const content = sanitizeParam(params.get('utm_content'));

    let utm = null;
    if (source || medium || campaign || content) {
      utm = {};
      if (source) utm.source = source;
      if (medium) utm.medium = medium;
      if (campaign) utm.campaign = campaign;
      if (content) utm.content = content;
      try {
        sessionStorage.setItem('novarum_utm', JSON.stringify(utm));
      } catch (_) {}
    } else {
      try {
        const stored = sessionStorage.getItem('novarum_utm');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const cleanStored = {};
            for (const key of ['source', 'medium', 'campaign', 'content']) {
              const s = sanitizeParam(parsed[key]);
              if (s) cleanStored[key] = s;
            }
            if (Object.keys(cleanStored).length > 0) {
              utm = cleanStored;
            }
          }
        }
      } catch (_) {}
    }
    return utm;
  }

  // 6. UUID v4 Generator for Idempotency
  function generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // 7. DOM Elements
  let backdrop, modal, closeBtn, formContainer, confirmationContainer, confirmationHeading;
  let form, nameInput, emailInput, phoneInput, termsCheckbox, marketingCheckbox;
  let skuSelect, productTag, productTitle, productSku, productPrice, submitBtn, submitBtnPrice;
  let intentLockedBanner, resetIntentBtn;
  let alertBox, alertTitle, alertMessage, retryBtn, newIntentBtn;
  let btnToggleLegalTerms, legalSummaryBox;
  let confirmedOrderNumber, confirmedProductTitle, confirmedTotalAmount, confirmedStatusBadge, confirmedExpiresAt;
  let btnCheckStatus, statusLookupFeedback, btnWhatsappPayment, btnCloseConfirmation;

  function initElements() {
    backdrop = document.getElementById('checkout-modal-backdrop');
    modal = document.getElementById('checkout-modal');
    closeBtn = document.getElementById('btn-close-checkout');
    formContainer = document.getElementById('checkout-form-container');
    confirmationContainer = document.getElementById('checkout-confirmation-container');
    confirmationHeading = document.getElementById('confirmation-heading');

    form = document.getElementById('checkout-form');
    nameInput = document.getElementById('checkout-name');
    emailInput = document.getElementById('checkout-email');
    phoneInput = document.getElementById('checkout-phone');
    termsCheckbox = document.getElementById('consent-terms');
    marketingCheckbox = document.getElementById('consent-marketing');

    skuSelect = document.getElementById('checkout-sku-select');
    productTag = document.getElementById('checkout-product-tag');
    productTitle = document.getElementById('checkout-product-title');
    productSku = document.getElementById('checkout-product-sku');
    productPrice = document.getElementById('checkout-product-price');
    submitBtn = document.getElementById('btn-submit-order');
    submitBtnPrice = document.getElementById('submit-btn-price');

    intentLockedBanner = document.getElementById('checkout-intent-locked-banner');
    resetIntentBtn = document.getElementById('btn-reset-intent');

    alertBox = document.getElementById('checkout-error-alert');
    alertTitle = document.getElementById('alert-title');
    alertMessage = document.getElementById('alert-message');
    retryBtn = document.getElementById('btn-retry-checkout');
    newIntentBtn = document.getElementById('btn-new-intent');

    btnToggleLegalTerms = document.getElementById('btn-toggle-legal-terms');
    legalSummaryBox = document.getElementById('checkout-legal-summary');

    confirmedOrderNumber = document.getElementById('confirmed-order-number');
    confirmedProductTitle = document.getElementById('confirmed-product-title');
    confirmedTotalAmount = document.getElementById('confirmed-total-amount');
    confirmedStatusBadge = document.getElementById('confirmed-status-badge');
    confirmedExpiresAt = document.getElementById('confirmed-expires-at');

    btnCheckStatus = document.getElementById('btn-check-order-status');
    statusLookupFeedback = document.getElementById('status-lookup-feedback');
    btnWhatsappPayment = document.getElementById('btn-whatsapp-payment');
    btnCloseConfirmation = document.getElementById('btn-close-confirmation');
  }

  // 8. Background Inertness & Focus Trap Management
  function setBackgroundInert(inertState) {
    if (!document.body) return;
    const children = Array.from(document.body.children);
    for (const child of children) {
      if (child === backdrop || child.tagName === 'SCRIPT') continue;
      if (inertState) {
        child.setAttribute('inert', '');
        child.setAttribute('aria-hidden', 'true');
      } else {
        child.removeAttribute('inert');
        child.removeAttribute('aria-hidden');
      }
    }
  }

  function getFocusableElements() {
    if (!modal) return [];
    const selector = [
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      'a[href]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');

    return Array.from(modal.querySelectorAll(selector)).filter((el) => {
      if (el.hidden) return false;
      let parent = el.parentElement;
      while (parent && parent !== modal) {
        if (parent.hidden) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  }

  function handleModalKeydown(e) {
    if (!backdrop || backdrop.hidden) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      closeCheckout();
      return;
    }

    if (e.key === 'Tab') {
      const focusable = getFocusableElements();
      if (focusable.length === 0) {
        e.preventDefault();
        if (modal) modal.focus();
        return;
      }

      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      const activeEl = document.activeElement;

      if (e.shiftKey) {
        if (activeEl === firstEl || activeEl === modal || !modal.contains(activeEl)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else {
        if (activeEl === lastEl || !modal.contains(activeEl)) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }
  }

  // 9. Product Display & Intent Lock Management
  function renderProductHeader(sku) {
    const prod = PRODUCTS[sku] || PRODUCTS['mujer-informada-4'];
    if (productTag) productTag.textContent = prod.tag;
    if (productTitle) productTitle.textContent = prod.title;
    if (productSku) productSku.textContent = `SKU: ${prod.sku}`;
    if (productPrice) productPrice.textContent = prod.priceFormatted;
    if (submitBtnPrice) submitBtnPrice.textContent = prod.priceFormatted;
    if (skuSelect && skuSelect.value !== prod.sku) {
      skuSelect.value = prod.sku;
    }
    if (!isSubmitting && submitBtn) {
      const btnText = submitBtn.querySelector('.btn-text');
      if (btnText) {
        btnText.textContent = '';
        btnText.appendChild(document.createTextNode('Confirmar Pedido — '));
        const priceSpan = document.createElement('span');
        priceSpan.id = 'submit-btn-price';
        priceSpan.textContent = prod.priceFormatted;
        btnText.appendChild(priceSpan);
        submitBtnPrice = priceSpan;
      }
    }
  }

  /**
   * Updates selected product ONLY if no submission is in flight and no intent is frozen.
   */
  function setProduct(sku) {
    if (isSubmitting || currentIntentSnapshot !== null) {
      // Prevent changing SKU while request is in flight or intent is frozen for retry
      if (skuSelect && currentIntentSnapshot) {
        skuSelect.value = currentIntentSnapshot.sku;
      }
      return false;
    }
    const resolvedSku = PRODUCTS[sku] ? sku : 'mujer-informada-4';
    currentSku = resolvedSku;
    renderProductHeader(resolvedSku);
    return true;
  }

  function syncFormLockState() {
    const locked = isSubmitting || currentIntentSnapshot !== null;
    if (skuSelect) skuSelect.disabled = locked;
    if (nameInput) nameInput.disabled = locked;
    if (emailInput) emailInput.disabled = locked;
    if (phoneInput) phoneInput.disabled = locked;
    if (termsCheckbox) termsCheckbox.disabled = locked;
    if (marketingCheckbox) marketingCheckbox.disabled = locked;

    if (intentLockedBanner) {
      intentLockedBanner.hidden = currentIntentSnapshot === null;
    }
  }

  function restoreFormFromSnapshot(snapshot) {
    if (!snapshot) return;
    currentSku = snapshot.sku;
    renderProductHeader(snapshot.sku);
    if (nameInput) nameInput.value = snapshot.name;
    if (emailInput) emailInput.value = snapshot.email;
    if (phoneInput) phoneInput.value = snapshot.phone || '';
    if (termsCheckbox) termsCheckbox.checked = Boolean(snapshot.terms_accepted);
    if (marketingCheckbox) marketingCheckbox.checked = Boolean(snapshot.marketing_opt_in);
  }

  /**
   * Explicitly starts a brand new purchase intent, unlocking fields and generating a new UUID.
   */
  function startNewIntent(optionalSku) {
    cancelInFlightRequest();
    setSubmittingState(false);
    currentIntentSnapshot = null;
    currentOpaqueToken = null;
    lastPendingAlert = null;
    currentIdempotencyKey = generateUUID();

    const nextSku =
      optionalSku && PRODUCTS[optionalSku]
        ? optionalSku
        : pendingRequestedSku && PRODUCTS[pendingRequestedSku]
          ? pendingRequestedSku
          : currentSku;
    pendingRequestedSku = null;
    currentSku = nextSku;

    if (hasCompletedOrder && form) {
      form.reset();
      hasCompletedOrder = false;
    }

    renderProductHeader(currentSku);
    syncFormLockState();
    clearAlert();
    clearErrors();
  }

  function cancelInFlightRequest() {
    activeRequestId += 1;
    if (activeAbortController) {
      try {
        activeAbortController.abort();
      } catch (_) {}
      activeAbortController = null;
    }
  }

  // 10. Staging Payment Coordination Guard
  function syncPaymentCoordinationButton(orderData, submittedProduct) {
    if (!btnWhatsappPayment) return;
    const enabled = window.NOVARUM_ENABLE_PAYMENT_COORDINATION === true;

    if (!enabled) {
      btnWhatsappPayment.disabled = true;
      btnWhatsappPayment.setAttribute('aria-disabled', 'true');
      btnWhatsappPayment.classList.add('btn-payment-disabled');
      btnWhatsappPayment.textContent = '🔒 Coordinación de Pago QR (Deshabilitado en Staging)';
      btnWhatsappPayment.onclick = null;
    } else {
      btnWhatsappPayment.disabled = false;
      btnWhatsappPayment.setAttribute('aria-disabled', 'false');
      btnWhatsappPayment.classList.remove('btn-payment-disabled');
      btnWhatsappPayment.textContent = '👨‍💼 Solicitar QR Bancario al Operador';
      btnWhatsappPayment.onclick = (e) => {
        e.preventDefault();
        if (!orderData || !submittedProduct) return;
      };
    }
  }

  // 11. Modal Open & Close Logic
  function openCheckout(sku, triggerElement) {
    if (!backdrop || !modal) return;

    lastTriggerElement =
      triggerElement instanceof HTMLElement
        ? triggerElement
        : document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : null;

    // P1: Preserve unresolved submitted intent across modal close & reopen.
    // Never overwrite a pending submitted intent or regenerate its idempotency_key automatically.
    if (currentIntentSnapshot !== null) {
      currentIdempotencyKey = currentIntentSnapshot.idempotency_key;
      restoreFormFromSnapshot(currentIntentSnapshot);
      syncFormLockState();
      clearErrors();

      if (sku && PRODUCTS[sku] && sku !== currentIntentSnapshot.sku) {
        pendingRequestedSku = sku;
      } else {
        pendingRequestedSku = null;
      }
    } else {
      startNewIntent(sku || currentSku);
    }

    if (formContainer) formContainer.hidden = false;
    if (confirmationContainer) confirmationContainer.hidden = true;
    if (statusLookupFeedback) {
      statusLookupFeedback.hidden = true;
      statusLookupFeedback.textContent = '';
    }
    if (legalSummaryBox) legalSummaryBox.hidden = true;
    if (btnToggleLegalTerms) btnToggleLegalTerms.setAttribute('aria-expanded', 'false');

    syncPaymentCoordinationButton(null, null);

    backdrop.hidden = false;
    setBackgroundInert(true);
    document.body.style.overflow = 'hidden';

    // Validate API configuration upfront so missing config is immediately visible
    const apiBase = resolveValidApiBase();
    if (!apiBase) {
      showAlert(
        'Servicio comercial no configurado',
        'La dirección del servidor comercial (NOVARUM_API_BASE) no está configurada o es inválida en este entorno. El registro de pedidos está bloqueado por seguridad.',
        false,
        false
      );
      if (submitBtn) submitBtn.disabled = true;
    } else {
      if (submitBtn) submitBtn.disabled = false;

      if (currentIntentSnapshot !== null) {
        if (lastPendingAlert && lastPendingAlert.type === 'conflict_409') {
          showAlert(lastPendingAlert.title, lastPendingAlert.message, false, true);
        } else if (pendingRequestedSku && pendingRequestedSku !== currentIntentSnapshot.sku) {
          const lockedProd = PRODUCTS[currentIntentSnapshot.sku];
          showAlert(
            'Intención de compra pendiente de resolución',
            `Ya enviaste una solicitud para "${lockedProd.title}" (SKU: ${currentIntentSnapshot.sku}) cuya respuesta no fue confirmada. Para evitar un segundo pedido accidental, no se puede cambiar de producto ni modificar los datos. Haz clic en "Reintentar" para recuperar tu pedido con la misma clave, o en "Nueva intención" bajo advertencia de posible pedido existente.`,
            true,
            true
          );
        } else if (lastPendingAlert) {
          showAlert(
            lastPendingAlert.title,
            lastPendingAlert.message,
            lastPendingAlert.showRetry,
            lastPendingAlert.showNewIntent
          );
        } else {
          showAlert(
            'Intención de compra protegida',
            'Tu solicitud previa sigue pendiente de confirmación. Tus datos, SKU y clave de idempotencia se han conservado para evitar pedidos duplicados. Haz clic en "Reintentar" para recuperar tu pedido o en "Nueva intención" bajo advertencia de posible pedido existente.',
            true,
            true
          );
        }
      }
    }

    setTimeout(() => {
      if (nameInput && !nameInput.disabled) {
        nameInput.focus();
      } else if (retryBtn && !retryBtn.hidden && !retryBtn.disabled) {
        retryBtn.focus();
      } else if (newIntentBtn && !newIntentBtn.hidden && !newIntentBtn.disabled) {
        newIntentBtn.focus();
      } else if (closeBtn) {
        closeBtn.focus();
      }
    }, 20);
  }

  function closeCheckout() {
    if (!backdrop) return;
    const wasSubmitting = isSubmitting;
    cancelInFlightRequest();
    setSubmittingState(false);

    if (wasSubmitting && currentIntentSnapshot !== null && !lastPendingAlert) {
      lastPendingAlert = {
        type: 'interrupted',
        title: 'Intención de compra pendiente de confirmación',
        message:
          'Cerraste la ventana mientras tu solicitud estaba enviándose. Es posible que tu pedido ya haya sido registrado en el servidor. Tus datos y tu clave de idempotencia siguen congelados: haz clic en "Reintentar" para recuperar tu pedido sin duplicarlo, o en "Nueva intención" bajo advertencia de posible pedido existente.',
        showRetry: true,
        showNewIntent: true,
      };
    }

    backdrop.hidden = true;
    setBackgroundInert(false);
    document.body.style.overflow = '';
    clearAlert();

    if (lastTriggerElement && typeof lastTriggerElement.focus === 'function' && document.contains(lastTriggerElement)) {
      const targetToFocus = lastTriggerElement;
      lastTriggerElement = null;
      targetToFocus.focus();
    }
  }

  // 12. Error & Alert Handlers
  function showAlert(title, message, showRetry = false, showNewIntent = false) {
    if (!alertBox) return;
    if (alertTitle) alertTitle.textContent = title;
    if (alertMessage) alertMessage.textContent = message;
    if (retryBtn) retryBtn.hidden = !showRetry;
    if (newIntentBtn) newIntentBtn.hidden = !showNewIntent;
    alertBox.hidden = false;
  }

  function clearAlert() {
    if (alertBox) alertBox.hidden = true;
    if (retryBtn) retryBtn.hidden = true;
    if (newIntentBtn) newIntentBtn.hidden = true;
  }

  function setFieldValidity(inputEl, errorElId, isValid) {
    const errEl = document.getElementById(errorElId);
    if (inputEl) {
      if (isValid) {
        inputEl.classList.remove('input-invalid');
        inputEl.setAttribute('aria-invalid', 'false');
      } else {
        inputEl.classList.add('input-invalid');
        inputEl.setAttribute('aria-invalid', 'true');
      }
    }
    if (errEl) {
      errEl.hidden = isValid;
    }
  }

  function clearErrors() {
    setFieldValidity(nameInput, 'name-error', true);
    setFieldValidity(emailInput, 'email-error', true);
    setFieldValidity(phoneInput, 'phone-error', true);
    setFieldValidity(termsCheckbox, 'terms-error', true);
  }

  // 13. Field Validation (Client-Side with Accessible ARIA Announcement)
  function validateSingleField(field) {
    if (field === nameInput) {
      const nameVal = nameInput ? nameInput.value.trim() : '';
      const nameRegex = /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s'-]+$/;
      const ok = nameVal.length >= 2 && nameVal.length <= 80 && nameRegex.test(nameVal);
      setFieldValidity(nameInput, 'name-error', ok);
      return ok;
    }
    if (field === emailInput) {
      const emailVal = emailInput ? emailInput.value.trim() : '';
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const ok = emailVal.length > 0 && emailVal.length <= 100 && emailRegex.test(emailVal);
      setFieldValidity(emailInput, 'email-error', ok);
      return ok;
    }
    if (field === phoneInput) {
      const phoneVal = phoneInput ? phoneInput.value.trim() : '';
      const phoneRegex = /^\+?[0-9]{7,15}$/;
      const ok = phoneVal.length === 0 || phoneRegex.test(phoneVal);
      setFieldValidity(phoneInput, 'phone-error', ok);
      return ok;
    }
    if (field === termsCheckbox) {
      const ok = Boolean(termsCheckbox && termsCheckbox.checked);
      setFieldValidity(termsCheckbox, 'terms-error', ok);
      return ok;
    }
    return true;
  }

  function validateForm() {
    clearErrors();
    let firstInvalid = null;

    if (!validateSingleField(nameInput) && !firstInvalid) firstInvalid = nameInput;
    if (!validateSingleField(emailInput) && !firstInvalid) firstInvalid = emailInput;
    if (!validateSingleField(phoneInput) && !firstInvalid) firstInvalid = phoneInput;
    if (!validateSingleField(termsCheckbox) && !firstInvalid) firstInvalid = termsCheckbox;

    if (firstInvalid && typeof firstInvalid.focus === 'function') {
      firstInvalid.focus();
    }

    return firstInvalid === null;
  }

  // 14. Strict Server Order Response Validation (P2 #5)
  function validateOrderResponse(orderData, submittedSnapshot) {
    if (!orderData || typeof orderData !== 'object' || Array.isArray(orderData)) {
      return { valid: false, reason: 'La respuesta del servidor no es un objeto JSON válido.' };
    }

    if (!submittedSnapshot || !PRODUCTS[submittedSnapshot.sku]) {
      return { valid: false, reason: 'No existe una intención de compra válida asociada a la respuesta.' };
    }

    const expectedProduct = PRODUCTS[submittedSnapshot.sku];

    if (typeof orderData.order_number !== 'string' || !/^DPS-\d{8}-\d+$/.test(orderData.order_number.trim())) {
      return { valid: false, reason: 'El número de pedido devuelto por el servidor es inválido o está ausente.' };
    }

    if (typeof orderData.opaque_token !== 'string' || !/^[a-f0-9]{64}$/i.test(orderData.opaque_token.trim())) {
      return {
        valid: false,
        reason: 'El token seguro de consulta devuelto por el servidor debe tener exactamente 64 caracteres hexadecimales.',
      };
    }

    if (
      typeof orderData.total_amount_minor !== 'number' ||
      !Number.isInteger(orderData.total_amount_minor) ||
      !Number.isFinite(orderData.total_amount_minor) ||
      orderData.total_amount_minor <= 0
    ) {
      return { valid: false, reason: 'El importe total devuelto por el servidor es inválido.' };
    }

    if (orderData.total_amount_minor !== expectedProduct.priceMinor) {
      return {
        valid: false,
        reason: 'El importe confirmado por el servidor no coincide con el producto enviado en esta intención.',
      };
    }

    if (orderData.currency !== 'BOB') {
      return { valid: false, reason: 'La moneda devuelta por el servidor no corresponde a BOB.' };
    }

    if (typeof orderData.status !== 'string' || !ALLOWED_ORDER_STATUSES.includes(orderData.status)) {
      return { valid: false, reason: 'El estado del pedido devuelto por el servidor no pertenece al contrato aprobado.' };
    }

    if (orderData.sku !== undefined && orderData.sku !== submittedSnapshot.sku) {
      return { valid: false, reason: 'El SKU devuelto por el servidor no coincide con el producto solicitado.' };
    }

    return { valid: true };
  }

  // 15. Process Checkout Submission (Immutable Snapshot & Race Safe)
  async function submitCheckout() {
    if (isSubmitting) return;

    const apiBase = resolveValidApiBase();
    if (!apiBase) {
      showAlert(
        'Servicio comercial no configurado',
        'La dirección del servidor comercial (NOVARUM_API_BASE) no está configurada o es inválida en este entorno. El registro de pedidos está bloqueado por seguridad.',
        false,
        false
      );
      if (submitBtn) submitBtn.disabled = true;
      return;
    }

    if (currentIntentSnapshot === null) {
      if (!validateForm()) {
        showAlert('Datos incompletos', 'Por favor revisa los campos señalados en rojo para continuar.', false, false);
        return;
      }

      if (!currentIdempotencyKey) {
        currentIdempotencyKey = generateUUID();
      }

      const utmData = getSanitizedUtm();
      const phoneTrimmed = phoneInput ? phoneInput.value.trim() : '';
      const rawPayload = {
        sku: currentSku,
        name: nameInput ? nameInput.value.trim() : '',
        email: emailInput ? emailInput.value.trim() : '',
        ...(phoneTrimmed ? { phone: phoneTrimmed } : {}),
        terms_accepted: Boolean(termsCheckbox && termsCheckbox.checked),
        marketing_opt_in: Boolean(marketingCheckbox && marketingCheckbox.checked),
        privacy_version: 'v1.0',
        idempotency_key: currentIdempotencyKey,
        ...(utmData ? { utm: Object.freeze({ ...utmData }) } : {}),
      };

      currentIntentSnapshot = Object.freeze(rawPayload);
    } else {
      // Ensure UI and key reflect the frozen snapshot even if DOM was tampered with or modal was reopened
      currentIdempotencyKey = currentIntentSnapshot.idempotency_key;
      restoreFormFromSnapshot(currentIntentSnapshot);
    }

    const submittedSnapshot = currentIntentSnapshot;
    const requestId = ++activeRequestId;
    if (activeAbortController) {
      try {
        activeAbortController.abort();
      } catch (_) {}
    }
    const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    activeAbortController = abortController;

    clearAlert();
    setSubmittingState(true, submittedSnapshot.sku);
    syncFormLockState();

    try {
      const response = await fetch(`${apiBase}/api/v1/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(submittedSnapshot),
        ...(abortController ? { signal: abortController.signal } : {}),
      });

      // Discard stale/late response if modal closed or intent changed
      if (requestId !== activeRequestId) {
        return;
      }

      const data = await response.json().catch(() => null);

      if (requestId !== activeRequestId) {
        return;
      }

      if (!response.ok) {
        setSubmittingState(false, submittedSnapshot.sku);
        syncFormLockState();

        if (response.status === 429) {
          lastPendingAlert = {
            type: 'rate_limit',
            title: 'Límite de solicitudes',
            message:
              'Demasiados intentos en poco tiempo. Tu intención de compra sigue protegida; espera unos momentos y vuelve a intentarlo.',
            showRetry: true,
            showNewIntent: true,
          };
          showAlert(
            lastPendingAlert.title,
            lastPendingAlert.message,
            lastPendingAlert.showRetry,
            lastPendingAlert.showNewIntent
          );
        } else if (response.status === 409) {
          // NEVER auto-regenerate idempotency_key on HTTP 409!
          // Require explicit user decision to start a new intent.
          lastPendingAlert = {
            type: 'conflict_409',
            title: 'Conflicto de intención de compra (HTTP 409)',
            message:
              'La clave de idempotencia actual ya fue registrada con datos distintos. Para evitar pedidos duplicados, la clave NO se regenera automáticamente. Haz clic en "Nueva intención" si deseas iniciar un pedido nuevo (advertencia: verifica antes si ya tienes un pedido registrado).',
            showRetry: false,
            showNewIntent: true,
          };
          showAlert(
            lastPendingAlert.title,
            lastPendingAlert.message,
            lastPendingAlert.showRetry,
            lastPendingAlert.showNewIntent
          );
        } else {
          const errMsg =
            data && typeof data.message === 'string' && data.message.trim().length > 0
              ? data.message
              : 'No fue posible registrar el pedido en este momento.';
          lastPendingAlert = {
            type: 'http_error',
            title: 'Error en el registro',
            message: errMsg,
            showRetry: true,
            showNewIntent: true,
          };
          showAlert(
            lastPendingAlert.title,
            lastPendingAlert.message,
            lastPendingAlert.showRetry,
            lastPendingAlert.showNewIntent
          );
        }
        return;
      }

      // Strictly validate 200/201 response payload before transitioning to confirmation
      const validation = validateOrderResponse(data, submittedSnapshot);
      if (!validation.valid) {
        setSubmittingState(false, submittedSnapshot.sku);
        syncFormLockState();
        lastPendingAlert = {
          type: 'invalid_response',
          title: 'Respuesta inválida del servidor',
          message: `${validation.reason} Puedes reintentar de forma segura con la misma clave protegida.`,
          showRetry: true,
          showNewIntent: true,
        };
        showAlert(
          lastPendingAlert.title,
          lastPendingAlert.message,
          lastPendingAlert.showRetry,
          lastPendingAlert.showNewIntent
        );
        return;
      }

      handleCheckoutSuccess(data, submittedSnapshot);
    } catch (networkErr) {
      if (requestId !== activeRequestId) {
        return;
      }
      setSubmittingState(false, submittedSnapshot.sku);
      syncFormLockState();
      lastPendingAlert = {
        type: 'network',
        title: 'Sin conexión al servidor',
        message:
          'No pudimos recibir la confirmación del servidor comercial. Es posible que tu pedido ya haya sido registrado. Tus datos y tu clave de idempotencia están congelados para evitar duplicados: haz clic en "Reintentar" para recuperar tu pedido o en "Nueva intención" bajo advertencia de posible pedido existente.',
        showRetry: true,
        showNewIntent: true,
      };
      showAlert(
        lastPendingAlert.title,
        lastPendingAlert.message,
        lastPendingAlert.showRetry,
        lastPendingAlert.showNewIntent
      );
    }
  }

  function setSubmittingState(loading, skuOverride) {
    isSubmitting = loading;
    if (!submitBtn) return;
    submitBtn.disabled = loading || !resolveValidApiBase();
    const btnText = submitBtn.querySelector('.btn-text');
    const btnSpinner = submitBtn.querySelector('.btn-spinner');
    const targetSku = skuOverride || (currentIntentSnapshot ? currentIntentSnapshot.sku : currentSku);
    const prod = PRODUCTS[targetSku] || PRODUCTS['mujer-informada-4'];

    if (loading) {
      if (btnText) btnText.textContent = 'Procesando pedido seguro...';
      if (btnSpinner) btnSpinner.hidden = false;
    } else {
      if (btnText) {
        btnText.textContent = '';
        btnText.appendChild(document.createTextNode('Confirmar Pedido — '));
        const priceSpan = document.createElement('span');
        priceSpan.id = 'submit-btn-price';
        priceSpan.textContent = prod.priceFormatted;
        btnText.appendChild(priceSpan);
        submitBtnPrice = priceSpan;
      }
      if (btnSpinner) btnSpinner.hidden = true;
    }
  }

  // 16. Display Confirmation State (Zero PII, Bound to Submitted Snapshot SKU)
  function handleCheckoutSuccess(orderData, submittedSnapshot) {
    setSubmittingState(false, submittedSnapshot.sku);
    currentOpaqueToken = orderData.opaque_token.trim();

    // Intent is now resolved and confirmed; clear pending unresolved state
    currentIntentSnapshot = null;
    currentIdempotencyKey = null;
    lastPendingAlert = null;
    pendingRequestedSku = null;
    hasCompletedOrder = true;
    syncFormLockState();

    if (formContainer) formContainer.hidden = true;
    if (confirmationContainer) confirmationContainer.hidden = false;

    const submittedProduct = PRODUCTS[submittedSnapshot.sku];

    if (confirmedOrderNumber) {
      confirmedOrderNumber.textContent = orderData.order_number.trim();
    }
    if (confirmedProductTitle) {
      confirmedProductTitle.textContent = submittedProduct.title;
    }
    if (confirmedTotalAmount) {
      const amountMajor = (orderData.total_amount_minor / 100).toFixed(2);
      confirmedTotalAmount.textContent = `Bs ${amountMajor} ${orderData.currency}`;
    }
    if (confirmedStatusBadge) {
      confirmedStatusBadge.textContent = ORDER_STATUS_LABELS[orderData.status];
    }
    if (confirmedExpiresAt) {
      if (orderData.expires_at) {
        const expDate = new Date(orderData.expires_at);
        if (!Number.isNaN(expDate.getTime())) {
          confirmedExpiresAt.textContent = `Hasta el ${expDate.toLocaleDateString()} a las ${expDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        } else {
          confirmedExpiresAt.textContent = '72 horas para validación de pago';
        }
      } else {
        confirmedExpiresAt.textContent = '72 horas para validación de pago';
      }
    }

    syncPaymentCoordinationButton(orderData, submittedProduct);

    if (confirmationHeading && typeof confirmationHeading.focus === 'function') {
      confirmationHeading.focus();
    }
  }

  // 17. Real-Time Order Status Check via Opaque Token (Zero PII & Safe DOM Text)
  async function checkOrderStatus() {
    if (
      !currentOpaqueToken ||
      typeof currentOpaqueToken !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(currentOpaqueToken.trim()) ||
      !statusLookupFeedback
    ) {
      return;
    }

    const apiBase = resolveValidApiBase();
    if (!apiBase) {
      statusLookupFeedback.hidden = false;
      statusLookupFeedback.className = 'status-lookup-feedback status-error';
      statusLookupFeedback.textContent = 'No se pudo consultar el estado: configuración de API inválida.';
      return;
    }

    const requestId = activeRequestId;
    statusLookupFeedback.hidden = false;
    statusLookupFeedback.className = 'status-lookup-feedback status-checking';
    statusLookupFeedback.textContent = 'Consultando estado seguro con el servidor...';

    try {
      const response = await fetch(`${apiBase}/api/v1/orders/${encodeURIComponent(currentOpaqueToken)}/status`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (requestId !== activeRequestId) return;

      const data = await response.json().catch(() => null);
      if (requestId !== activeRequestId) return;

      if (
        !response.ok ||
        !data ||
        typeof data !== 'object' ||
        typeof data.status !== 'string' ||
        !ALLOWED_ORDER_STATUSES.includes(data.status)
      ) {
        statusLookupFeedback.className = 'status-lookup-feedback status-error';
        statusLookupFeedback.textContent = 'No se pudo verificar un estado válido en este momento. Intenta de nuevo más tarde.';
        return;
      }

      const safeLabel = ORDER_STATUS_LABELS[data.status];
      statusLookupFeedback.className = 'status-lookup-feedback status-success';
      statusLookupFeedback.textContent = '';
      const strongEl = document.createElement('strong');
      strongEl.textContent = 'Estado Verificado: ';
      statusLookupFeedback.appendChild(strongEl);
      statusLookupFeedback.appendChild(document.createTextNode(safeLabel));

      if (confirmedStatusBadge) {
        confirmedStatusBadge.textContent = safeLabel;
      }
    } catch (_) {
      if (requestId !== activeRequestId) return;
      statusLookupFeedback.className = 'status-lookup-feedback status-error';
      statusLookupFeedback.textContent = 'Error de conectividad al consultar el estado.';
    }
  }

  // 18. Initialization & Event Binding
  function initCheckout() {
    initElements();

    // Bind Catalog Purchase Buttons
    const catalogButtons = document.querySelectorAll('[data-action="open-checkout"]');
    catalogButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const sku = btn.getAttribute('data-sku') || 'mujer-informada-4';
        openCheckout(sku, btn);
      });
    });

    // Close Modal Button & Backdrop
    if (closeBtn) {
      closeBtn.addEventListener('click', closeCheckout);
    }
    if (backdrop) {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          closeCheckout();
        }
      });
    }

    // Keyboard ESC & Tab Focus Trap
    document.addEventListener('keydown', handleModalKeydown);

    // SKU Switcher inside Modal (only allowed when intent is not locked)
    if (skuSelect) {
      skuSelect.addEventListener('change', (e) => {
        if (isSubmitting || currentIntentSnapshot !== null) {
          e.target.value = currentIntentSnapshot ? currentIntentSnapshot.sku : currentSku;
          return;
        }
        startNewIntent(e.target.value);
      });
    }

    // Live Accessible Field Validation on Blur / Input
    const watchedFields = [nameInput, emailInput, phoneInput, termsCheckbox].filter(Boolean);
    watchedFields.forEach((field) => {
      field.addEventListener('blur', () => {
        if (!isSubmitting && currentIntentSnapshot === null && field.value !== '') {
          validateSingleField(field);
        }
      });
      const clearOrRevalidate = () => {
        if (field.getAttribute('aria-invalid') === 'true') {
          validateSingleField(field);
        }
      };
      field.addEventListener('input', clearOrRevalidate);
      field.addEventListener('change', clearOrRevalidate);
    });

    // Legal Terms Summary Disclosure Toggle
    if (btnToggleLegalTerms && legalSummaryBox) {
      btnToggleLegalTerms.addEventListener('click', () => {
        const isHidden = legalSummaryBox.hidden;
        legalSummaryBox.hidden = !isHidden;
        btnToggleLegalTerms.setAttribute('aria-expanded', String(isHidden));
      });
    }

    // Form Submission
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submitCheckout();
      });
    }

    // Retry Button (re-submits the exact frozen snapshot)
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        submitCheckout();
      });
    }

    // Explicit New Intent Buttons
    if (newIntentBtn) {
      newIntentBtn.addEventListener('click', () => {
        startNewIntent();
        if (nameInput) nameInput.focus();
      });
    }
    if (resetIntentBtn) {
      resetIntentBtn.addEventListener('click', () => {
        startNewIntent();
        if (nameInput) nameInput.focus();
      });
    }

    // Check Order Status Button
    if (btnCheckStatus) {
      btnCheckStatus.addEventListener('click', checkOrderStatus);
    }

    // Close Confirmation Button
    if (btnCloseConfirmation) {
      btnCloseConfirmation.addEventListener('click', closeCheckout);
    }

    // Ensure staging payment button starts disabled unless flag is true
    syncPaymentCoordinationButton(null, null);

    // Check for direct SKU hash in URL (e.g. #comprar-endometriosis)
    const hash = window.location.hash;
    if (hash && hash.startsWith('#comprar-')) {
      const requestedSku = hash.replace('#comprar-', '');
      if (PRODUCTS[requestedSku]) {
        openCheckout(requestedSku);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCheckout);
  } else {
    initCheckout();
  }

  // Expose API for testing & diagnostics
  window.NovarumCheckout = {
    PRODUCTS,
    ALLOWED_ORDER_STATUSES,
    ORDER_STATUS_LABELS,
    openCheckout,
    closeCheckout,
    submitCheckout,
    setProduct,
    startNewIntent,
    validateForm,
    validateOrderResponse,
    resolveValidApiBase,
    checkOrderStatus,
    getSanitizedUtm,
    getIdempotencyKey: () => currentIdempotencyKey,
    setIdempotencyKey: (k) => {
      if (currentIntentSnapshot === null) {
        currentIdempotencyKey = k;
      }
    },
    getIntentSnapshot: () => currentIntentSnapshot,
    getOpaqueToken: () => currentOpaqueToken,
    setOpaqueToken: (t) => {
      currentOpaqueToken = t;
    },
    isSubmitting: () => isSubmitting,
  };
})();
